import { EmbedBuilder, MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { getStorageStats } from '../utils/storage.js';
import { getUniqueUserCount } from '../utils/user-tracking.js';

const logger = createLogger('stats');

const { gifStoragePath: GIF_STORAGE_PATH } = botConfig;

/**
 * Format uptime in a human-readable format
 * @param {number} milliseconds - Uptime in milliseconds
 * @returns {string} Formatted uptime string
 */
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

/**
 * Handle stats command
 * @param {Interaction} interaction - Discord interaction
 * @param {number} botStartTime - Bot start timestamp
 */
export async function handleStatsCommand(interaction, botStartTime) {
  try {
    const storageStats = await getStorageStats(GIF_STORAGE_PATH);
    const uptime = botStartTime ? Date.now() - botStartTime : 0;
    const client = interaction.client;
    const guildCount = client.guilds.cache.size;
    const userCount = await getUniqueUserCount();

    const embed = new EmbedBuilder()
      .setTitle('bot statistics')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'bot info',
          value: `uptime: \`${formatUptime(uptime)}\`\nguilds: \`${guildCount.toLocaleString()}\`\nusers: \`${userCount.toLocaleString()}\``,
          inline: false,
        },
        {
          name: 'file storage',
          value: `total gifs: \`${storageStats.totalGifs.toLocaleString()}\`\ntotal videos: \`${storageStats.totalVideos.toLocaleString()}\`\ntotal images: \`${storageStats.totalImages.toLocaleString()}\`\ndisk usage: \`${storageStats.diskUsageFormatted}\``,
          inline: false,
        }
      );

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    await interaction.reply({
      content: 'an error occurred while fetching statistics.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
