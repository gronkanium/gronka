import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, firstUrlIn } from '../utils/validation.js';
import { validateMediaFile } from './shared/media-validation.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import { downloadImage } from '../utils/file-downloader.js';
import { isAdmin } from '../utils/rate-limit.js';
import { isGifFile, optimizeCached, calculateSizeReduction } from '../utils/gif-optimizer.js';
import { logOperationStep } from '../utils/operations-tracker.js';
import { hashUrlWithParams } from '../utils/hashing.js';
import { getProcessedUrl } from '../utils/database.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { replyIfRateLimited, refuse, commandSourceOf } from './shared/command-guards.js';
import {
  safeInteractionEditReply,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { storeMedia, deliverStored, finishCommand } from './shared/deliver.js';
import { fetchUrlInput } from './shared/url-input.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';

const logger = createLogger('optimize');

const { discordSizeLimit: DISCORD_SIZE_LIMIT } = botConfig;

export async function processOptimization(
  interaction,
  attachment,
  adminUser,
  preDownloaded = null,
  lossyLevel = null,
  originalUrl = null,
  commandSource = null
) {
  const lossy = lossyLevel ?? null;
  await runMediaCommand(
    'optimize',
    interaction,
    async ctx => {
      const { operationId } = ctx;
      const urlHash = originalUrl
        ? hashUrlWithParams(originalUrl, lossy === null ? {} : { lossy })
        : null;
      const cachedRow = urlHash ? await getProcessedUrl(urlHash) : null;
      const cachedGif = cachedRow?.file_type === 'gif' || cachedRow?.file_extension === '.gif';
      if (cachedGif && !cachedRow.r2_expired_at) {
        await safeInteractionEditReply(interaction, { content: cachedRow.file_url });
        return finishCommand('optimize', ctx, 0);
      }

      const gif = validateMediaFile(
        preDownloaded ?? (await downloadImage(attachment.url, adminUser)),
        'gif'
      );
      logOperationStep(operationId, 'optimization_start', 'running', {
        message: 'Starting GIF optimization',
        metadata: { inputFile: attachment.name || 'unknown', inputSize: gif.size, lossy },
      });
      const optimized = await optimizeCached(gif, lossy);
      logOperationStep(operationId, 'optimization_complete', 'success', {
        message: 'GIF optimization completed',
        metadata: {
          originalSize: gif.size,
          optimizedSize: optimized.file.size,
          sizeReduction: calculateSizeReduction(gif.size, optimized.file.size),
          lossy,
        },
      });

      const stored = await storeMedia(
        { ...optimized.file, filename: `${optimized.hash}.gif`, contentType: 'image/gif' },
        ctx,
        getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT),
        { hash: optimized.hash }
      );
      await deliverStored(interaction, ctx, stored, { urlHash: urlHash ?? optimized.hash });
      await finishCommand('optimize', ctx, stored.size);
    },
    {
      commandSource,
      skipDbInit: true,
      errorFallback: 'an error occurred while optimizing the gif.',
      context: {
        commandOptions: { lossy },
        ...(originalUrl ? { originalUrl } : {}),
        ...(attachment
          ? {
              attachment: {
                name: attachment.name || null,
                size: attachment.size || null,
                contentType: attachment.contentType || null,
                url: attachment.url || null,
              },
            }
          : {}),
      },
    }
  );
}

const attachmentJson = attachment =>
  attachment && {
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
  };

// The gif (downloading a url) an optimize was given; replies and returns null on failure.
async function resolveGif(interaction, { attachment, url, adminUser, commandSource }) {
  let file = null;
  let originalUrl = null;
  if (url) {
    try {
      ({ attachment, file, originalUrl } = await fetchUrlInput(url, adminUser, interaction.client));
    } catch (error) {
      await refuse(interaction, 'optimize', {
        message: curatedErrorMessage(error, 'failed to download file from URL.'),
        cause: error,
        reason: 'url_download_failed',
        context: { originalUrl: url, commandSource },
        notify: true,
      });
      return null;
    }
  }
  if (!isGifFile(attachment.name, attachment.contentType)) {
    const { name, size, contentType } = attachment;
    await refuse(interaction, 'optimize', {
      message: 'this command only works on gif files.',
      reason: url ? null : 'invalid_attachment_type',
      context: { attachment: { name, size, contentType, url: attachment.url }, commandSource },
      notify: true,
    });
    return null;
  }
  return { attachment, file, originalUrl };
}

// The bot's half: checks that answer privately before anything is deferred or queued.
async function acceptGif(interaction, { attachment, url, adminUser, commandSource }) {
  if (!url)
    return (await resolveGif(interaction, { attachment, adminUser, commandSource })) !== null;
  const check = validateUrl(url);
  if (!check.valid) {
    await refuse(interaction, 'optimize', {
      message: `invalid URL: ${check.error}`,
      reason: 'invalid_url',
      context: { originalUrl: url, commandSource },
      notify: true,
    });
  }
  return check.valid;
}

// The job half, run by a worker (or inline).
export async function runOptimizeJob(
  interaction,
  { attachment, url, lossy = null, commandSource }
) {
  const adminUser = isAdmin(interaction.user.id);
  const input = await resolveGif(interaction, { attachment, url, adminUser, commandSource });
  if (!input) return;
  await processOptimization(
    interaction,
    input.attachment,
    adminUser,
    input.file,
    lossy,
    input.originalUrl,
    commandSource
  );
}

// The context menu cannot defer: it has to answer with the lossy-level modal. The gif itself is
// fetched by the job once the modal is submitted.
export async function handleOptimizeContextMenuCommand(interaction, modalAttachmentCache) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'optimize') {
    return;
  }
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);
  const guard = { type: 'optimize', action: 'optimizing another gif' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource: 'context-menu' })) {
    return;
  }

  const { attachments, content } = interaction.targetMessage;
  const attachment = attachments.find(
    att => att.contentType === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
  );
  const url = attachment ? null : firstUrlIn(content);
  if (!attachment && !url) {
    await refuse(interaction, 'optimize', {
      message: 'no gif attachment or URL found in this message.',
      reason: 'missing_input',
      context: { commandSource: 'context-menu' },
      notify: true,
    });
    return;
  }
  const commandSource = 'context-menu';
  if (!(await acceptGif(interaction, { attachment, url, adminUser, commandSource }))) return;

  const modal = new ModalBuilder()
    .setCustomId(`optimize_modal_${Date.now()}`)
    .setTitle('optimize gif');

  const lossyInput = new TextInputBuilder()
    .setCustomId('lossy_level')
    .setLabel('lossy level (0-100, default: 35)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('35')
    .setRequired(false)
    .setMaxLength(3);

  const actionRow = new ActionRowBuilder().addComponents(lossyInput);
  modal.addComponents(actionRow);

  const modalId = modal.data.custom_id;
  modalAttachmentCache.set(modalId, {
    attachment: attachmentJson(attachment),
    url,
    timestamp: Date.now(),
  });

  const modalShown = await interaction.showModal(modal).then(
    () => true,
    error => {
      logger.debug(`Could not show the optimize modal: ${error.message}`);
      return false;
    }
  );
  if (!modalShown) {
    modalAttachmentCache.delete(modalId);
    logger.warn(`Failed to show modal for user ${userId}, cleaned up cache entry`);
  }
}

export async function handleOptimizeCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);
  logger.debug(
    `User ${userId} initiated optimization via slash command${adminUser ? ' [ADMIN]' : ''}`
  );
  const guard = { type: 'optimize', action: 'optimizing another gif' };
  if (
    await replyIfRateLimited(interaction, { ...guard, commandSource: commandSourceOf(interaction) })
  ) {
    return;
  }

  const attachment = interaction.options.getAttachment('file');
  const rawUrl = interaction.options.getString('url');
  const url = firstUrlIn(rawUrl) ?? rawUrl;
  const lossyLevel = interaction.options.getNumber('lossy');
  const context = { commandSource: commandSourceOf(interaction) };

  if (lossyLevel !== null && (lossyLevel < 0 || lossyLevel > 100)) {
    await refuse(interaction, 'optimize', {
      message: 'lossy level must be between 0 and 100.',
      reason: 'invalid_lossy_level',
      context: { ...context, commandOptions: { lossy: lossyLevel } },
    });
    return;
  }
  if (!attachment && !url) {
    const message = 'please provide either a gif attachment or a URL to a gif file.';
    await refuse(interaction, 'optimize', { message, reason: 'missing_input', context });
    return;
  }
  if (attachment && url) {
    const message = 'please provide either a file attachment or a URL, not both.';
    await refuse(interaction, 'optimize', { message, reason: 'multiple_inputs', context });
    return;
  }

  const commandSource = commandSourceOf(interaction);
  if (!(await acceptGif(interaction, { attachment, url, adminUser, commandSource }))) return;
  await safeInteractionDeferReply(interaction);
  await dispatchMediaJob(interaction, 'optimize', {
    attachment: attachmentJson(attachment),
    url,
    lossy: lossyLevel,
    commandSource,
  });
}
