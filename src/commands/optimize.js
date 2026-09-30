import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, firstUrlIn } from '../utils/validation.js';
import { writeValidatedFileBuffer } from './shared/buffer-validation.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import { downloadImage } from '../utils/file-downloader.js';
import { isAdmin } from '../utils/rate-limit.js';
import { isGifFile, optimizeCached, calculateSizeReduction } from '../utils/gif-optimizer.js';
import { logOperationStep } from '../utils/operations-tracker.js';
import { notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { hashUrlWithParams } from '../utils/hashing.js';
import { getProcessedUrl } from '../utils/database.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { replyIfRateLimited, refuse, replyError } from './shared/command-guards.js';
import {
  safeInteractionEditReply,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { storeMedia, deliverStored, finishCommand } from './shared/deliver.js';
import { fetchUrlInput } from './shared/url-input.js';

const logger = createLogger('optimize');

const { discordSizeLimit: DISCORD_SIZE_LIMIT } = botConfig;

export async function processOptimization(
  interaction,
  attachment,
  adminUser,
  preDownloadedBuffer = null,
  lossyLevel = null,
  originalUrl = null,
  commandSource = null
) {
  const lossy = lossyLevel ?? null;
  await runMediaCommand(
    'optimize',
    interaction,
    async ctx => {
      const { operationId, tempFiles } = ctx;
      const urlHash = originalUrl
        ? hashUrlWithParams(originalUrl, lossy === null ? {} : { lossy })
        : null;
      const cachedRow = urlHash ? await getProcessedUrl(urlHash) : null;
      const cachedGif = cachedRow?.file_type === 'gif' || cachedRow?.file_extension === '.gif';
      if (cachedGif && !cachedRow.r2_expired_at) {
        await safeInteractionEditReply(interaction, { content: cachedRow.file_url });
        return finishCommand('optimize', ctx, 0);
      }

      const fileBuffer = preDownloadedBuffer ?? (await downloadImage(attachment.url, adminUser));
      const tempDir = path.resolve('temp');
      const inputPath = path.join(tempDir, `gif_input_${Date.now()}.gif`);
      await fs.mkdir(tempDir, { recursive: true });
      await writeValidatedFileBuffer(inputPath, fileBuffer);
      tempFiles.push(inputPath);

      logOperationStep(operationId, 'optimization_start', 'running', {
        message: 'Starting GIF optimization',
        metadata: { inputFile: attachment.name || 'unknown', inputSize: fileBuffer.length, lossy },
      });
      const optimized = await optimizeCached(fileBuffer, inputPath, lossy);
      logOperationStep(operationId, 'optimization_complete', 'success', {
        message: 'GIF optimization completed',
        metadata: {
          originalSize: fileBuffer.length,
          optimizedSize: optimized.buffer.length,
          sizeReduction: calculateSizeReduction(fileBuffer.length, optimized.buffer.length),
          lossy,
        },
      });

      const stored = await storeMedia(
        { buffer: optimized.buffer, filename: `${optimized.hash}.gif`, contentType: 'image/gif' },
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

// Checks the gif (or downloads the url) an optimize was given; replies and returns null on failure.
async function gatherGif(interaction, { attachment, url, adminUser, commandSource, defer }) {
  let buffer = null;
  let originalUrl = null;
  if (url) {
    const check = validateUrl(url);
    if (!check.valid) {
      await refuse(interaction, 'optimize', {
        message: `invalid URL: ${check.error}`,
        reason: 'invalid_url',
        context: { originalUrl: url, commandSource },
        notify: true,
      });
      return null;
    }
    if (defer) await safeInteractionDeferReply(interaction);
    try {
      ({ attachment, buffer, originalUrl } = await fetchUrlInput(
        url,
        adminUser,
        interaction.client
      ));
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${interaction.user.id}:`, error);
      const message = curatedErrorMessage(error, 'failed to download file from URL.');
      await replyError(interaction, message);
      await notifyCommandFailure('optimize', { userId: interaction.user.id, error: error.message });
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
  return { attachment, buffer, originalUrl };
}

// The context menu cannot defer: it has to answer with the lossy-level modal.
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
  const input = await gatherGif(interaction, {
    attachment,
    url,
    adminUser,
    commandSource: 'context-menu',
    defer: false,
  });
  if (!input) return;

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
    attachment: input.attachment,
    attachmentType: 'gif',
    adminUser,
    preDownloadedBuffer: input.buffer,
    originalUrl: input.originalUrl,
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
  logger.info(
    `User ${userId} initiated optimization via slash command${adminUser ? ' [ADMIN]' : ''}`
  );
  const guard = { type: 'optimize', action: 'optimizing another gif' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource: 'slash' })) {
    return;
  }

  const attachment = interaction.options.getAttachment('file');
  const rawUrl = interaction.options.getString('url');
  const url = firstUrlIn(rawUrl) ?? rawUrl;
  const lossyLevel = interaction.options.getNumber('lossy');
  const context = { commandSource: 'slash' };

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

  const input = await gatherGif(interaction, {
    attachment,
    url,
    adminUser,
    commandSource: 'slash',
    defer: true,
  });
  if (!input) return;
  await safeInteractionDeferReply(interaction);
  await processOptimization(
    interaction,
    input.attachment,
    adminUser,
    input.buffer,
    lossyLevel,
    input.originalUrl,
    'slash'
  );
}
