import { Client, GatewayIntentBits, Events } from 'discord.js';
import { createHash, timingSafeEqual } from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createLogger } from './utils/logger.js';
import { botConfig, serverConfig } from './utils/config.js';
import { ConfigurationError } from './utils/errors.js';
import { trackUser, initializeUserTracking } from './utils/user-tracking.js';
import { handleStatsCommand } from './commands/stats.js';
import { handleDownloadCommand, handleDownloadContextMenuCommand } from './commands/download.js';
import { handleOptimizeCommand, handleOptimizeContextMenuCommand } from './commands/optimize.js';
import { handleConvertCommand, handleConvertContextMenu } from './commands/convert.js';
import { handleInfoCommand } from './commands/info.js';
import { handleModalSubmit } from './handlers/modals.js';
import { cleanupStuckOperations } from './utils/operations-tracker.js';
import { initializeR2UsageCache, formatFileSize } from './utils/storage.js';
import { r2Config } from './utils/config.js';
import { startCleanupJob, stopCleanupJob } from './utils/r2-cleanup.js';
import { initDatabase, getSetting, setSetting } from './utils/database.js';
import { get24HourStats } from './utils/database/stats.js';
import { replyIfBanned, replyIfMaintenance } from './utils/ban-check.js';
import { refreshRateLimitSettings } from './utils/rate-limit.js';

// Initialize logger
const logger = createLogger('bot');

// Configuration from centralized config
const {
  discordToken: DISCORD_TOKEN,
  clientId: CLIENT_ID,
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
} = botConfig;

const {
  serverPort: SERVER_PORT,
  serverHost: SERVER_HOST,
  statsUsername: STATS_USERNAME,
  statsPassword: STATS_PASSWORD,
} = serverConfig;

// Store attachment info for modal submissions: customId -> { attachment, attachmentType, adminUser, preDownloadedBuffer }
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

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // Required for DM support
    GatewayIntentBits.MessageContent, // Required to access attachments
  ],
});

// Track bot start time for uptime
let botStartTime = null;

// Track R2 cleanup job interval ID for graceful shutdown
let cleanupJobIntervalId = null;

// HTTP server for stats endpoint (minimal, only for Jekyll stats site)
let httpServer = null;

/**
 * Constant-time string comparison to prevent timing attacks on credentials.
 * Hashing both sides first equalizes lengths so timingSafeEqual can be used.
 */
function safeCompare(a, b) {
  const hashA = createHash('sha256').update(String(a)).digest();
  const hashB = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Basic authentication middleware for stats endpoint
 */
function basicAuth(req, res, next) {
  if (!STATS_USERNAME || !STATS_PASSWORD) {
    // No auth configured, allow access
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Stats API"');
    return res.status(401).json({ error: 'authentication required' });
  }

  const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
  const separatorIndex = credentials.indexOf(':');
  const username = separatorIndex === -1 ? credentials : credentials.slice(0, separatorIndex);
  const password = separatorIndex === -1 ? '' : credentials.slice(separatorIndex + 1);

  if (safeCompare(username, STATS_USERNAME) && safeCompare(password, STATS_PASSWORD)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Stats API"');
  return res.status(401).json({ error: 'invalid credentials' });
}

/**
 * Start minimal HTTP server for stats endpoint
 * Only serves /api/stats/24h for Jekyll stats site integration
 */
function startStatsServer() {
  const app = express();

  // Trust proxy for proper IP detection
  app.set('trust proxy', 1);

  // Rate limit all stats server routes - they perform authorization and database work
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: 'too many requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // Parse JSON bodies for status endpoint
  app.use(express.json());

  // Security headers
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Bot status update endpoint (protected with basic auth)
  // Used by npm run bot:status script to update presence without creating a new Discord connection
  app.post('/api/bot/status', basicAuth, async (req, res) => {
    try {
      const { status, activity } = req.body;

      if (!client.isReady()) {
        return res.status(503).json({ error: 'bot is not ready' });
      }

      const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
          error: `invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      const presenceOptions = {};
      if (status) {
        presenceOptions.status = status;
      }
      if (activity) {
        presenceOptions.activities = [
          {
            name: activity,
            type: 4, // ActivityType.Custom
          },
        ];
      }

      await client.user.setPresence(presenceOptions);

      // Persist so the presence survives restarts (restored in ClientReady).
      // setPresence without activities implicitly clears them, so mirror that:
      // a status-only update stores an empty activity.
      try {
        if (status) {
          await setSetting('bot_presence_status', status);
        }
        await setSetting('bot_presence_activity', activity || '');
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

  // Current bot presence endpoint (protected with basic auth)
  app.get('/api/bot/status', basicAuth, (req, res) => {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'bot is not ready' });
    }

    const presence = client.user.presence;
    const activity = presence.activities.find(a => a.type === 4) || null;

    res.json({
      status: presence.status,
      activity: activity ? activity.name : null,
      botTag: client.user.tag,
    });
  });

  // 24-hour stats endpoint for Jekyll site (protected with basic auth)
  app.get('/api/stats/24h', basicAuth, async (req, res) => {
    try {
      logger.debug('24-hour stats API requested');

      const stats = await get24HourStats();

      res.json({
        unique_users: stats.unique_users,
        total_files: stats.total_files,
        total_data_bytes: stats.total_data_bytes,
        total_data_formatted: formatFileSize(stats.total_data_bytes),
        period: '24 hours',
        last_updated: stats.timestamp,
      });
    } catch (error) {
      logger.error('Failed to get 24-hour stats:', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).json({
        error: 'failed to get stats',
        message: error.message,
      });
    }
  });

  // Start server
  httpServer = app.listen(SERVER_PORT, SERVER_HOST, () => {
    logger.info(`stats server running on http://${SERVER_HOST}:${SERVER_PORT}`);
    logger.info(`stats endpoint: http://${SERVER_HOST}:${SERVER_PORT}/api/stats/24h`);
  });

  httpServer.on('error', error => {
    logger.error('Stats server error:', error);
  });
}

// Event handlers
client.once(Events.ClientReady, async readyClient => {
  try {
    botStartTime = Date.now();
    await initializeUserTracking();

    // Restore the last presence set via the webui/stats API; default matches the
    // previous hardcoded 'dnd'. A DB hiccup here must not abort startup.
    try {
      const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
      let savedStatus = await getSetting('bot_presence_status', 'dnd');
      if (!validStatuses.includes(savedStatus)) {
        savedStatus = 'dnd';
      }
      const savedActivity = await getSetting('bot_presence_activity', '');
      const presenceOptions = { status: savedStatus };
      if (savedActivity) {
        presenceOptions.activities = [{ name: savedActivity, type: 4 }]; // ActivityType.Custom
      }
      readyClient.user.setPresence(presenceOptions);
    } catch (presenceError) {
      logger.warn(`Failed to restore saved presence: ${presenceError.message}`);
      readyClient.user.setPresence({ status: 'dnd' });
    }
    logger.info(`bot logged in as ${readyClient.user.tag}`);
    logger.info(`gif storage: ${GIF_STORAGE_PATH}`);
    logger.info(`cdn url: ${CDN_BASE_URL}`);

    // Initialize R2 usage cache on startup (if R2 is configured)
    // This caches R2 stats to limit class A operations (LIST requests) for the /stats Discord command
    await initializeR2UsageCache();

    // Load webui-managed admins + rate-limit cooldown now and keep the cache
    // fresh (webui writes to the DB from a separate process, so polling is the
    // sync mechanism)
    await refreshRateLimitSettings();
    setInterval(async () => {
      await refreshRateLimitSettings();
    }, 60 * 1000);

    // Clean up stuck operations every 5 minutes
    setInterval(
      async () => {
        try {
          await cleanupStuckOperations(10, readyClient); // 10 minute timeout, pass client for DM notifications
        } catch (error) {
          logger.error('Error in stuck operations cleanup:', error);
        }
      },
      5 * 60 * 1000
    ); // Run cleanup every 5 minutes

    // Start R2 cleanup job if enabled
    if (r2Config.cleanupEnabled && r2Config.tempUploadsEnabled) {
      try {
        cleanupJobIntervalId = startCleanupJob(
          r2Config,
          r2Config.cleanupIntervalMs,
          r2Config.cleanupLogLevel
        );
        logger.info(
          `Started R2 cleanup job (interval: ${r2Config.cleanupIntervalMs}ms, log level: ${r2Config.cleanupLogLevel})`
        );
      } catch (error) {
        logger.error(`Failed to start R2 cleanup job: ${error.message}`, error);
      }
    } else {
      if (r2Config.cleanupEnabled && !r2Config.tempUploadsEnabled) {
        logger.warn(
          'R2 cleanup job is enabled but temporary uploads tracking is disabled. Cleanup job will not run.'
        );
      }
    }
  } catch (error) {
    logger.error('Unhandled error during ClientReady initialization:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    logger.debug(
      `Received interaction: ${interaction.type} from user ${interaction.user.id} (${interaction.user.tag})`
    );
    // Track user interaction (non-blocking to avoid interaction timeout)
    const username = interaction.user.tag || interaction.user.username || 'unknown';
    trackUser(interaction.user.id, username).catch(error => {
      logger.debug(`Failed to track user ${interaction.user.id}: ${error.message}`);
    });

    if (await replyIfBanned(interaction)) {
      return;
    }

    if (await replyIfMaintenance(interaction)) {
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction, modalAttachmentCache);
    } else if (interaction.isMessageContextMenuCommand()) {
      // Route to appropriate handler based on command name
      if (interaction.commandName === 'download') {
        await handleDownloadContextMenuCommand(interaction);
      } else if (interaction.commandName === 'optimize') {
        await handleOptimizeContextMenuCommand(interaction, modalAttachmentCache);
      } else if (interaction.commandName === 'convert to gif') {
        await handleConvertContextMenu(interaction);
      }
    } else if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;

      if (commandName === 'stats') {
        await handleStatsCommand(interaction, botStartTime);
      } else if (commandName === 'download') {
        await handleDownloadCommand(interaction);
      } else if (commandName === 'optimize') {
        await handleOptimizeCommand(interaction);
      } else if (commandName === 'convert') {
        await handleConvertCommand(interaction);
      } else if (commandName === 'info') {
        await handleInfoCommand(interaction);
      }
    }
  } catch (error) {
    logger.error('Unhandled error in interaction handler:', error);
  }
});

client.on(Events.Error, error => {
  logger.error('Discord error:', error);
});

// Validate configuration
try {
  // Config validation happens during import, but check here for clarity
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

    // Start stats HTTP server (minimal, only for /api/stats/24h endpoint)
    if (SERVER_PORT) {
      startStatsServer();
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

// Graceful shutdown handlers
function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  if (cleanupJobIntervalId) {
    stopCleanupJob(cleanupJobIntervalId);
  }
  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  }
  // Give servers time to close before exiting
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', error => {
  logger.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
});
