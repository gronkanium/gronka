import { EmbedBuilder, MessageFlags } from 'discord.js';
import os from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { getR2CacheStats } from '../utils/storage.js';
import { r2Config } from '../utils/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const logger = createLogger('info');

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

/**
 * Format process uptime
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatProcessUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Handle info command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleInfoCommand(interaction) {
  try {
    // Get host information
    const platform = os.platform();
    const arch = os.arch();
    const cpuCount = os.cpus().length;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);

    // Get R2 cache statistics
    const r2CacheStats = getR2CacheStats();
    const r2Configured =
      r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey && r2Config.bucketName;

    // Get runtime information
    const nodeVersion = process.version;
    const processUptime = formatProcessUptime(process.uptime());
    const botVersion = packageJson.version || 'unknown';

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle('system information')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'host information',
          value: `platform: \`${platform}\`\narchitecture: \`${arch}\`\ncpus: \`${cpuCount}\`\nmemory: \`${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memUsagePercent}%)\``,
          inline: false,
        },
        {
          name: 'r2 storage',
          value: r2Configured
            ? r2CacheStats.initialized
              ? `usage: \`${r2CacheStats.usageFormatted}\`\nfree: \`${r2CacheStats.freeFormatted}\`\nlimit: \`${r2CacheStats.limitFormatted}\`\nused: \`${r2CacheStats.percentageUsed}%\`\ncache age: \`${r2CacheStats.cacheAgeFormatted}\``
              : 'cache not initialized'
            : 'not configured',
          inline: false,
        },
        {
          name: 'runtime information',
          value: `node.js: \`${nodeVersion}\`\nprocess uptime: \`${processUptime}\`\nbot version: \`${botVersion}\``,
          inline: false,
        }
      )
      .setFooter({
        text: '[join our server for questions or feature requests](https://discord.gg/MHM2m4keTX)',
      });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Failed to get info:', error);
    await interaction.reply({
      content: 'an error occurred while fetching system information.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
