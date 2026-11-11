import { ModalBuilder, LabelBuilder, RadioGroupBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { firstUrlIn } from '../utils/validation.js';
import { readLink } from '../core/intake.js';
import { validateMediaFile } from './shared/media-validation.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import { isGifFile, optimizeToJob } from '../utils/gif-optimizer.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { refuse } from './shared/command-guards.js';
import { safeInteractionDeferReply } from '../utils/interaction-helpers.js';
import { storeMedia, deliverStored, finishCommand } from './shared/deliver.js';
import { fetchInput } from './shared/media-input.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import { formatSizeChange } from './shared/media-reply.js';
import { messageMediaInput } from './shared/message-media.js';
import { askForInput } from './shared/input-modal.js';

const logger = createLogger('optimize');

const MISSING_INPUT = 'please provide either a gif attachment or a URL to a gif file.';
// Discord's docs say extension-only types break mobile pickers; other images become optimized gifs.
const GIF_UPLOAD = { label: 'upload a gif', fileTypes: ['image'] };

async function processOptimization(
  interaction,
  attachment,
  file,
  lossyLevel = null,
  originalUrl = null,
  commandSource = null
) {
  const lossy = lossyLevel ?? null;
  await runMediaCommand(
    'optimize',
    interaction,
    async () => {
      const gif = validateMediaFile(file, 'gif');
      const optimized = await optimizeToJob(gif, lossy);

      const stored = await storeMedia(optimized, getDiscordAttachmentLimit(interaction));
      await deliverStored(interaction, stored, {
        description: formatSizeChange(gif.size, optimized.size),
      });
      await finishCommand();
    },
    {
      commandSource,
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

async function checkGif(interaction, attachment, { fromUrl, commandSource }) {
  if (isGifFile(attachment.name, attachment.contentType)) return true;
  const { name, size, contentType } = attachment;
  await refuse(interaction, 'optimize', {
    message: 'this command only works on gif files.',
    reason: fromUrl ? null : 'invalid_attachment_type',
    context: { attachment: { name, size, contentType, url: attachment.url }, commandSource },
  });
  return false;
}

// The gif an optimize was given, downloaded; replies and returns null on failure.
async function resolveGif(interaction, { attachment, url, commandSource }) {
  if (attachment && !(await checkGif(interaction, attachment, { commandSource }))) return null;
  let input;
  try {
    input = await fetchInput({ attachment, url }, interaction.client);
  } catch (error) {
    await refuse(interaction, 'optimize', {
      message: curatedErrorMessage(error, 'failed to download that file.'),
      cause: error,
      reason: 'url_download_failed',
      context: { originalUrl: url ?? attachment.url, commandSource },
    });
    return null;
  }
  if (url && !(await checkGif(interaction, input.attachment, { fromUrl: true, commandSource }))) {
    return null;
  }
  return input;
}

// The bot's half: checks that answer privately before anything is deferred or queued.
async function acceptGif(interaction, { attachment, url, commandSource }) {
  if (!url) return checkGif(interaction, attachment, { commandSource });
  const { refusal } = readLink(url);
  if (refusal) {
    await refuse(interaction, 'optimize', {
      ...refusal,
      context: { originalUrl: url, commandSource },
    });
  }
  return !refusal;
}

// The job half, run by a worker (or inline).
export async function runOptimizeJob(
  interaction,
  { attachment, url, lossy = null, commandSource }
) {
  const input = await resolveGif(interaction, { attachment, url, commandSource });
  if (!input) return;
  await processOptimization(
    interaction,
    input.attachment,
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

  const { attachment, url } = messageMediaInput(interaction.targetMessage, attachments =>
    attachments.find(att => isGifFile(att.name, att.contentType))
  );
  if (!attachment && !url) {
    await askForInput(interaction, 'optimize', GIF_UPLOAD, []);
    return;
  }
  const commandSource = 'context-menu';
  if (!(await acceptGif(interaction, { attachment, url, commandSource }))) return;

  const modal = new ModalBuilder()
    .setCustomId(`optimize_modal_${Date.now()}`)
    .setTitle('optimize gif');

  const lossy = new RadioGroupBuilder()
    .setCustomId('lossy_level')
    .setRequired(true)
    .addOptions(
      { label: 'light', value: '15', description: 'less compression, bigger file' },
      { label: 'balanced', value: '35', description: 'the default', default: true },
      { label: 'strong', value: '80', description: 'more compression, smaller file' }
    );
  modal.addLabelComponents(
    new LabelBuilder().setLabel('compression').setRadioGroupComponent(lossy)
  );

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
    logger.warn('Failed to show the optimize modal, cleaned up cache entry');
  }
}

export async function handleOptimizeCommand(interaction) {
  const attachment = interaction.options.getAttachment('file');
  const rawUrl = interaction.options.getString('link');
  const url = attachment ? null : (firstUrlIn(rawUrl) ?? rawUrl);
  const lossyLevel = interaction.options.getNumber('lossy');
  const commandSource = 'slash';
  const context = { commandSource };

  if (lossyLevel !== null && (lossyLevel < 0 || lossyLevel > 100)) {
    await refuse(interaction, 'optimize', {
      message: 'lossy level must be between 0 and 100.',
      reason: 'invalid_lossy_level',
      context: { ...context, commandOptions: { lossy: lossyLevel } },
    });
    return;
  }
  if (!attachment && !url) {
    await askForInput(interaction, 'optimize', GIF_UPLOAD, [lossyLevel]);
    return;
  }
  await startOptimize(interaction, { attachment, url, lossyLevel, commandSource });
}

export async function submitOptimizeInput(interaction, { options: [lossy], attachment, url }) {
  const commandSource = 'slash';
  if (!attachment && !url) {
    await refuse(interaction, 'optimize', {
      message: MISSING_INPUT,
      reason: 'missing_input',
      context: { commandSource },
    });
    return;
  }
  const lossyLevel = lossy ? Number(lossy) : null;
  await startOptimize(interaction, { attachment, url, lossyLevel, commandSource });
}

async function startOptimize(interaction, { attachment, url, lossyLevel, commandSource }) {
  if (attachment && !isGifFile(attachment.name, attachment.contentType)) {
    await safeInteractionDeferReply(interaction);
    await dispatchMediaJob(interaction, 'convert', {
      attachment: attachmentJson(attachment),
      url: null,
      format: 'gif',
      gifOptions: { optimize: true, lossy: lossyLevel ?? undefined },
      commandSource,
    });
    return;
  }
  if (!(await acceptGif(interaction, { attachment, url, commandSource }))) return;
  await safeInteractionDeferReply(interaction);
  await dispatchMediaJob(interaction, 'optimize', {
    attachment: attachmentJson(attachment),
    url,
    lossy: lossyLevel,
    commandSource,
  });
}
