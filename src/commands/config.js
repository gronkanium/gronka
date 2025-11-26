import { EmbedBuilder, MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { getUserConfig, setUserConfig } from '../utils/user-config.js';
import { isAdmin } from '../utils/rate-limit.js';

const logger = createLogger('config');

const { defaultFps: DEFAULT_FPS } = botConfig;

/**
 * Handle config command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleConfigCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  // Check if user is admin
  if (!adminUser) {
    logger.warn(`Non-admin user ${userId} (${interaction.user.tag}) attempted to use /config`);
    await interaction.reply({
      content: 'this command is only available to admin users.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'view') {
    try {
      const userConfig = await getUserConfig(userId);

      const embed = new EmbedBuilder()
        .setTitle('your configuration')
        .setColor(0x00ff00)
        .setDescription('current personal settings for gif conversion')
        .addFields(
          {
            name: 'fps',
            value: userConfig.fps !== null ? userConfig.fps.toString() : `default (${DEFAULT_FPS})`,
            inline: true,
          },
          {
            name: 'width',
            value: userConfig.width !== null ? userConfig.width.toString() : `default (480)`,
            inline: true,
          },
          {
            name: 'quality',
            value: userConfig.quality !== null ? userConfig.quality : 'default (high)',
            inline: true,
          },
          {
            name: 'autoOptimize',
            value: userConfig.autoOptimize ? 'enabled' : 'disabled',
            inline: true,
          }
        )
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error(`Failed to load config for user ${userId}:`, error);
      await interaction.reply({
        content: 'failed to load your configuration.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } else if (subcommand === 'set') {
    try {
      const updates = {};
      const fps = interaction.options.getNumber('fps');
      const width = interaction.options.getNumber('width');
      const quality = interaction.options.getString('quality');
      const autoOptimize = interaction.options.getBoolean('auto_optimize');

      if (fps !== null) {
        updates.fps = fps;
      }
      if (width !== null) {
        updates.width = width;
      }
      if (quality !== null) {
        updates.quality = quality;
      }
      if (autoOptimize !== null) {
        updates.autoOptimize = autoOptimize;
      }

      if (Object.keys(updates).length === 0) {
        await interaction.reply({
          content:
            'please specify at least one setting to update (fps, width, quality, or auto_optimize).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const result = await setUserConfig(userId, updates, adminUser);

      if (!result.success) {
        await interaction.reply({
          content: `failed to update configuration: ${result.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const updatedFields = [];
      if (fps !== null) {
        updatedFields.push(`**fps**: ${fps}`);
      }
      if (width !== null) {
        updatedFields.push(`**width**: ${width}`);
      }
      if (quality !== null) {
        updatedFields.push(`**quality**: ${quality}`);
      }
      if (autoOptimize !== null) {
        updatedFields.push(`**autoOptimize**: ${autoOptimize ? 'enabled' : 'disabled'}`);
      }

      await interaction.reply({
        content: `configuration updated:\n${updatedFields.join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });

      logger.info(
        `User ${userId} (${interaction.user.tag}) updated their config: ${JSON.stringify(updates)}`
      );
    } catch (error) {
      logger.error(`Failed to update config for user ${userId}:`, error);
      await interaction.reply({
        content: 'an error occurred while updating your configuration.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
