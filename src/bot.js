import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createLogger } from './utils/logger.js';
import { botConfig, serverConfig } from './utils/config.js';
import { ConfigurationError } from './utils/errors.js';
import { DISCORD_REST_TIMEOUT_MS } from './utils/interaction-helpers.js';
import { startRetentionJob, stopRetentionJob } from './utils/retention.js';
import {
  handleDownloadCommand,
  handleDownloadContextMenuCommand,
  queueDownload,
} from './commands/download.js';
import { handleOptimizeCommand, handleOptimizeContextMenuCommand } from './commands/optimize.js';
import { handleConvertCommand, handleConvertContextMenu } from './commands/convert.js';
import { handleInfoCommand } from './commands/info.js';
import { handleModalSubmit } from './handlers/modals.js';
import { handleMangaInteraction } from './commands/manga.js';
import { handleMegaKeyInteraction } from './commands/mega-key.js';
import { handlePrefixMessage } from './handlers/prefix-commands.js';
import { flushCounts } from './utils/operations-tracker.js';
import { initializeR2UsageCache } from './utils/storage.js';
import { r2Config } from './utils/config.js';
import { startCleanupJob, stopCleanupJob } from './utils/r2-cleanup.js';
import { initDatabase, closeDatabase } from './utils/database.js';
import {
  VALID_PRESENCE_STATUSES,
  DEFAULT_PRESENCE_STATUS,
  buildPresenceOptions,
  activityDisplayText,
  loadSavedPresence,
  saveSavedPresence,
} from './utils/presence.js';
import { replyIfMaintenance } from './utils/maintenance.js';
import { reportPresence, clearPresence, PRESENCE_MS } from './utils/database/media-jobs-pg.js';
import { withJobDir, sweepJobDirs } from './utils/media-file.js';

const logger = createLogger('bot');

const { discordToken: DISCORD_TOKEN, clientId: CLIENT_ID } = botConfig;

const { serverPort: SERVER_PORT, serverHost: SERVER_HOST } = serverConfig;

// Optimize modal state; the file is re-fetched on submit since the menu's job dir is gone by then.
const modalAttachmentCache = new Map();

// Clean up modal cache entries older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of modalAttachmentCache.entries()) {
    if (value.timestamp && now - value.timestamp > 5 * 60 * 1000) {
      modalAttachmentCache.delete(key);
    }
  }
}, 60 * 1000); // Run cleanup every minute

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // Required for DM support
  ],
  partials: [Partials.Channel], // Required to receive MessageCreate in DMs (prefix commands)
  rest: { timeout: DISCORD_REST_TIMEOUT_MS },
});

let botStartTime = null;

// Track R2 cleanup job interval ID for graceful shutdown
let cleanupJobIntervalId = null;
let retentionJobIntervalId = null;

// HTTP server for stats endpoint (minimal, only for Jekyll stats site)
let httpServer = null;

/**
 * Minimal HTTP server: /health for the Docker healthcheck and /api/bot/status
 */
function startStatsServer() {
  const app = express();

  // Rate limit every route, /api/bot/status writes to the database
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: 'too many requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.use(express.json());

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Used by npm run bot:status script to update presence without creating a new Discord connection
  app.post('/api/bot/status', async (req, res) => {
    try {
      const { status, activity } = req.body;

      if (!client.isReady()) {
        return res.status(503).json({ error: 'bot is not ready' });
      }

      if (status && !VALID_PRESENCE_STATUSES.includes(status)) {
        return res.status(400).json({
          error: `invalid status "${status}". Must be one of: ${VALID_PRESENCE_STATUSES.join(', ')}`,
        });
      }

      await client.user.setPresence(buildPresenceOptions(status, activity));

      // Persist so the presence survives restarts (replayed into the identify payload
      // by startBot(), which is the only way it reliably sticks).
      try {
        await saveSavedPresence(status, activity);
      } catch (persistError) {
        logger.warn(`Failed to persist bot presence: ${persistError.message}`);
      }

      const statusMsg = activity
        ? `Status updated to "${status || 'current'}" with activity: "${activity}"`
        : `Status updated to "${status}"`;
      logger.info(statusMsg);

      res.json({
        success: true,
        status: status || 'unchanged',
        activity: activity || null,
        botTag: client.user.tag,
      });
    } catch (error) {
      logger.error('Failed to update bot status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/bot/status', (req, res) => {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'bot is not ready' });
    }

    // This is the client's own presence, which Discord never echoes back to bots (that would
    // need the GuildPresences intent), so it reflects what this process last sent. Since the
    // saved presence now rides along in the identify payload, that matches what Discord shows.
    const presence = client.user.presence;
    const activity = presence.activities.find(a => a.type === ActivityType.Custom) || null;

    res.json({
      status: presence.status,
      // Custom statuses keep their text in `state`; `name` is the fixed "Custom Status".
      activity: activityDisplayText(activity),
      botTag: client.user.tag,
    });
  });

  app.get('/health', (req, res) => res.status(client.isReady() ? 200 : 503).end());

  httpServer = app.listen(SERVER_PORT, SERVER_HOST, () => {
    logger.info(`stats server running on http://${SERVER_HOST}:${SERVER_PORT}`);
    logger.info(`health endpoint: http://${SERVER_HOST}:${SERVER_PORT}/health`);
  });

  httpServer.on('error', error => {
    logger.error('Stats server error:', error);
  });
}

client.once(Events.ClientReady, async readyClient => {
  try {
    botStartTime = Date.now();

    // The identify payload already carried this presence (see startBot), that is what makes it
    // stick across a restart, with no race against the presence discord.js sends on identify.
    // Re-assert it here anyway: identify does not patch the client's local presence, which is
    // what GET /api/bot/status reads back, and this also covers a pre-login load that failed.
    // Both paths send the same values, so whichever Discord applies last is the right one.
    try {
      const { status, activity } = await loadSavedPresence();
      readyClient.user.setPresence(buildPresenceOptions(status, activity));
      logger.info(`restored presence: ${status}${activity ? ` (${activity})` : ' (no activity)'}`);
    } catch (presenceError) {
      logger.warn(`Failed to restore saved presence: ${presenceError.message}`);
      readyClient.user.setPresence({ status: DEFAULT_PRESENCE_STATUS });
    }
    logger.info(`bot logged in as ${readyClient.user.tag}`);

    // Initialize R2 usage cache on startup (if R2 is configured)
    // This caches R2 stats to limit class A operations (LIST requests) for the /stats Discord command
    await initializeR2UsageCache();

    const report = () =>
      reportPresence({ role: 'bot' }).catch(error =>
        logger.warn(`Presence report failed: ${error.message}`)
      );
    report();
    setInterval(report, PRESENCE_MS);

    await sweepJobDirs().catch(error => logger.warn(`Job dir sweep failed: ${error.message}`));
    setInterval(
      () => sweepJobDirs().catch(error => logger.warn(`Job dir sweep failed: ${error.message}`)),
      30 * 60 * 1000
    );

    if (botConfig.retentionEnabled) {
      try {
        retentionJobIntervalId = startRetentionJob({
          days: botConfig.retentionDays,
          intervalMs: botConfig.retentionIntervalMs,
        });
      } catch (error) {
        logger.error(`Failed to start retention job: ${error.message}`, error);
      }
    } else {
      logger.warn('Retention is disabled: error logs and alerts will grow without limit');
    }

    if (r2Config.cleanupEnabled) {
      cleanupJobIntervalId = startCleanupJob(r2Config, r2Config.cleanupIntervalMs);
    }
  } catch (error) {
    logger.error('Unhandled error during ClientReady initialization:', error);
  }
});

client.on(Events.InteractionCreate, interaction =>
  withJobDir(() => handleInteraction(interaction))
);

async function handleInteraction(interaction) {
  try {
    if (await replyIfMaintenance(interaction)) {
      return;
    }

    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      if (await handleMangaInteraction(interaction, queueDownload)) {
        return;
      }
      if (await handleMegaKeyInteraction(interaction, queueDownload)) {
        return;
      }
      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction, modalAttachmentCache);
      }
    } else if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === 'download') {
        await handleDownloadContextMenuCommand(interaction);
      } else if (interaction.commandName === 'optimize') {
        await handleOptimizeContextMenuCommand(interaction, modalAttachmentCache);
      } else if (interaction.commandName === 'convert to gif') {
        await handleConvertContextMenu(interaction);
      }
    } else if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;

      if (commandName === 'download') {
        await handleDownloadCommand(interaction);
      } else if (commandName === 'optimize') {
        await handleOptimizeCommand(interaction);
      } else if (commandName === 'convert') {
        await handleConvertCommand(interaction);
      } else if (commandName === 'info') {
        await handleInfoCommand(interaction, botStartTime);
      }
    }
  } catch (error) {
    logger.error('Unhandled error in interaction handler:', error);
  }
}

// Prefix commands ("^download <url>", "@gronka help", ...). The handler does its own
// bot/webhook filtering, ban/maintenance checks, and per-guild prefix resolution.
client.on(Events.MessageCreate, async message => {
  try {
    await handlePrefixMessage(message, { botStartTime });
  } catch (error) {
    logger.error('Unhandled error in message handler:', error);
  }
});

client.on(Events.Error, error => {
  logger.error('Discord error:', error);
});

try {
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new ConfigurationError('Required configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Initialize database early before starting bot
// This prevents lazy initialization overhead during command execution
async function startBot() {
  try {
    logger.info('Initializing database...');
    await initDatabase();
    logger.info('Database initialized');

    if (SERVER_PORT) {
      startStatsServer();
    }

    // Restore the last presence set via the webui/stats API by putting it in the identify
    // payload. discord.js always sends a presence on identify (defaulting to online with no
    // activities), so setting it after ClientReady loses a race against that default and the
    // bot comes up online with no custom status. Doing it here also means a gateway
    // re-identify (reconnect after a failed resume) replays the presence for free.
    // A DB hiccup here must not abort startup, ClientReady retries.
    try {
      const { status, activity } = await loadSavedPresence();
      client.options.presence = buildPresenceOptions(status, activity);
    } catch (presenceError) {
      logger.warn(`Failed to load saved presence before login: ${presenceError.message}`);
    }

    logger.info('Starting Discord bot...');
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    logger.error('an error occurred:', error);
    logger.error('error message:', error.message);
    logger.error('error stack:', error.stack);
    process.exit(1);
  }
}

startBot();

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);
  setTimeout(() => process.exit(1), 8000).unref();
  const warn = label => error => logger.warn(`${label}: ${error.message}`);
  if (cleanupJobIntervalId) stopCleanupJob(cleanupJobIntervalId);
  if (retentionJobIntervalId) stopRetentionJob(retentionJobIntervalId);
  await clearPresence().catch(warn('Could not clear presence'));
  if (httpServer) httpServer.close();
  await flushCounts().catch(warn('Could not flush counts'));
  await client.destroy();
  await closeDatabase().catch(warn('Could not close database'));
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', error => {
  logger.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  logger.error('Uncaught exception, exiting:', error);
  process.exit(1);
});
