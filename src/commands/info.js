import { EmbedBuilder, MessageFlags } from 'discord.js';
import os from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { safeInteractionReply } from '../utils/interaction-helpers.js';
import { getR2CacheStats, getStorageStats } from '../utils/storage.js';
import { getUniqueUserCount } from '../utils/user-tracking.js';
import { r2Config, botConfig } from '../utils/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const logger = createLogger('info');

const { gifStoragePath: GIF_STORAGE_PATH } = botConfig;

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

function formatUptime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatR2Line(r2CacheStats) {
  const configured =
    r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey && r2Config.bucketName;

  if (!configured) return 'r2: `not configured`';
  if (!r2CacheStats.initialized) return 'r2: `cache not initialized`';

  return (
    `r2: \`${r2CacheStats.usageFormatted} / ${r2CacheStats.limitFormatted} ` +
    `(${r2CacheStats.percentageUsed}%)\` · cache age: \`${r2CacheStats.cacheAgeFormatted}\``
  );
}

export async function handleInfoCommand(interaction, botStartTime) {
  try {
    const storageStats = await getStorageStats(GIF_STORAGE_PATH);
    const userCount = await getUniqueUserCount();
    const guildCount = interaction.client.guilds.cache.size;

    // botStartTime is null on the prefix path when the bot has not recorded one yet; the
    // process clock is the same number in practice, since the bot logs in at startup.
    const uptime = botStartTime ? Date.now() - botStartTime : process.uptime() * 1000;

    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);

    // process.version reports the Node API level Bun emulates, not a real Node install —
    // the container runs Bun only, so report that instead or the number is a lie.
    const bunVersion = process.versions.bun;

    const embed = new EmbedBuilder()
      .setTitle('gronka — info')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'usage',
          value:
            `uptime: \`${formatUptime(uptime)}\`\n` +
            `guilds: \`${guildCount.toLocaleString()}\` · users: \`${userCount.toLocaleString()}\``,
          inline: false,
        },
        {
          name: 'storage',
          value:
            `gifs: \`${storageStats.totalGifs.toLocaleString()}\` · ` +
            `videos: \`${storageStats.totalVideos.toLocaleString()}\` · ` +
            `images: \`${storageStats.totalImages.toLocaleString()}\`\n` +
            `disk: \`${storageStats.diskUsageFormatted}\`\n` +
            formatR2Line(getR2CacheStats()),
          inline: false,
        },
        {
          name: 'system',
          value:
            `\`${os.platform()}/${os.arch()}\` · \`${os.cpus().length} cpus\` · ` +
            `memory: \`${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memUsagePercent}%)\`\n` +
            `bun: \`v${bunVersion}\` · gronka: \`v${packageJson.version}\``,
          inline: false,
        },
        {
          name: '​',
          value:
            '[join our server for questions or feature requests](https://discord.gg/MHM2m4keTX)',
          inline: false,
        }
      );

    await safeInteractionReply(interaction, { embeds: [embed] });
  } catch (error) {
    logger.error('Failed to get info:', error);
    await safeInteractionReply(interaction, {
      content: 'an error occurred while fetching bot information.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
