import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, validateFileExtension, firstUrlIn } from '../utils/validation.js';
import { validateMediaFile } from './shared/media-validation.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import { downloadVideo, downloadImage } from '../utils/file-downloader.js';
import { isAdmin } from '../utils/rate-limit.js';
import {
  ALLOWED_VIDEO_TYPES,
  ALLOWED_IMAGE_TYPES,
  validateVideoAttachment,
  validateImageAttachment,
} from '../utils/attachment-helpers.js';
import {
  convertToGif,
  getVideoMetadata,
  convertImageToGif,
  convertAnimatedWebpToGif,
  isAnimatedWebp,
  convertToFormat,
  OUTPUT_FORMATS,
} from '../utils/video-processor.js';
import { mediaPath } from '../utils/storage.js';
import { getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { loadStoredGif, optimizeCached } from '../utils/gif-optimizer.js';
import { logOperationStep } from '../utils/operations-tracker.js';
import { hashUrlWithParams, hashPartsHex } from '../utils/hashing.js';
import { getProcessedUrl } from '../utils/database.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { sendConvertedFile } from './shared/send-converted.js';
import { ValidationError } from '../utils/errors.js';
import {
  replyIfRateLimited,
  resolveTimeOptions,
  refuse,
  commandSourceOf,
} from './shared/command-guards.js';
import { initializeDatabaseWithErrorHandling } from '../utils/database-init.js';
import { safeInteractionDeferReply } from '../utils/interaction-helpers.js';
import { storeMedia, deliverStored, deliverReply, finishCommand } from './shared/deliver.js';
import { fetchUrlInput } from './shared/url-input.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import { fromPath, writeAtomic } from '../utils/media-file.js';

const logger = createLogger('convert');

const {
  gifStoragePath: GIF_STORAGE_PATH,
  maxGifDuration: MAX_GIF_DURATION,
  discordSizeLimit: DISCORD_SIZE_LIMIT,
} = botConfig;

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.awebp', '.gif'];
const UNSUPPORTED_FORMAT =
  'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).';

async function probeMediaInfo(filePath, fallbackWidth) {
  let width = fallbackWidth;
  let fps = 30;

  try {
    const metadata = await getVideoMetadata(filePath);
    const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
    if (videoStream) {
      if (typeof videoStream.width === 'number' && videoStream.width > 0) {
        width = videoStream.width;
      }
      // fps comes as a fraction string like "30000/1001"
      const fpsStr = videoStream.r_frame_rate || videoStream.avg_frame_rate;
      if (typeof fpsStr === 'string' && fpsStr.includes('/')) {
        const [num, den] = fpsStr.split('/').map(Number);
        if (den > 0 && num > 0) {
          const calculated = num / den;
          if (calculated > 0.1 && calculated <= 120) {
            fps = calculated;
          }
        }
      } else if (typeof fpsStr === 'number' && fpsStr > 0.1 && fpsStr <= 120) {
        fps = fpsStr;
      }
    }
  } catch (error) {
    logger.warn(`Failed to probe media metadata, using fallbacks: ${error.message}`);
  }

  return { width, fps };
}

// Default ceilings for a video-to-GIF conversion when the user doesn't specify.
// GIF is a wildly inefficient container: a source-resolution / full-framerate encode of an
// ordinary phone clip balloons to 100-240MB, which is slow to encode, can't go to Discord, and
// (when several run at once) starved the box until the stuck-operation reaper failed the job.
// These caps keep default output sane and fast to encode; an explicit width/fps still overrides.
const DEFAULT_MAX_GIF_WIDTH = 640;
const DEFAULT_MAX_GIF_FPS = 20;

// Resolve the effective settings for a video-to-GIF conversion
function resolveVideoConversionOptions(options, probed) {
  const defaultWidth = Math.min(probed.width, DEFAULT_MAX_GIF_WIDTH);
  if (options.width == null && probed.width > DEFAULT_MAX_GIF_WIDTH) {
    logger.debug(`Clamping default width from ${probed.width}px to ${defaultWidth}px`);
  }

  const defaultFps = Math.min(probed.fps, DEFAULT_MAX_GIF_FPS);
  if (options.fps == null && probed.fps > DEFAULT_MAX_GIF_FPS) {
    logger.debug(`Clamping default FPS from ${probed.fps.toFixed(1)}fps to ${defaultFps}fps`);
  }

  return {
    width: options.width ?? defaultWidth,
    fps: options.fps ?? defaultFps,
    startTime: options.startTime ?? null,
    duration: options.duration ?? null,
  };
}

async function processFormatConversion(
  interaction,
  attachment,
  adminUser,
  preDownloaded,
  format,
  trim,
  originalUrl,
  commandSource = null
) {
  const spec = OUTPUT_FORMATS[format];
  const isGif = attachment.contentType === 'image/gif';
  const isVideo = ALLOWED_VIDEO_TYPES.includes(attachment.contentType);
  await runMediaCommand(
    'convert',
    interaction,
    async ctx => {
      const { operationId } = ctx;
      if (!isVideo && spec.kind === 'audio') {
        throw new ValidationError('only videos have audio to turn into audio files.');
      }
      if (!isVideo && !isGif && spec.kind === 'video') {
        throw new ValidationError('still images can only be converted to png, jpg, webp or gif.');
      }
      const input =
        preDownloaded ||
        (isVideo
          ? await downloadVideo(attachment.url, adminUser)
          : await downloadImage(attachment.url, adminUser));
      logOperationStep(operationId, 'format_convert', 'running', {
        message: `Converting to ${format}`,
        metadata: { format, inputSize: input.size },
      });
      const output = await convertToFormat(input, format, isVideo ? trim : {});
      const baseName =
        path.parse(attachment.name || 'file').name.replace(/[^\w.-]+/g, '_') || 'file';
      await sendConvertedFile(
        interaction,
        {
          ...ctx,
          discordAttachmentLimit: getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT),
        },
        { file: output, format, baseName }
      );
      logOperationStep(operationId, 'format_convert', 'success', {
        message: `Converted to ${format}`,
        metadata: { format, outputSize: output.size },
      });
      await finishCommand('convert', ctx, output.size);
    },
    {
      commandSource,
      skipDbInit: true,
      errorFallback: 'an error occurred while converting the file.',
      context: {
        commandOptions: { format, ...trim },
        ...(originalUrl ? { originalUrl } : {}),
        attachment: {
          name: attachment.name || null,
          size: attachment.size || null,
          contentType: attachment.contentType || null,
          url: attachment.url || null,
        },
      },
    }
  );
}

// Renders the source file into gifPath with ffmpeg or ImageMagick.
async function renderGif(ctx, { attachment, attachmentType, adminUser, file, options, gifPath }) {
  const { operationId } = ctx;
  let ext = path.extname(attachment.name ?? '').toLowerCase();
  const allowed = attachmentType === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!ext || !validateFileExtension(attachment.name, allowed)) {
    ext = attachmentType === 'video' ? '.mp4' : '.png';
  }
  const inputPath = validateMediaFile(file, attachmentType).path;
  await fs.mkdir(path.dirname(gifPath), { recursive: true });
  logOperationStep(operationId, 'conversion_start', 'running', {
    message: `Starting ${attachmentType} to GIF conversion`,
    metadata: { inputFile: attachment.name, inputSize: attachment.size },
  });

  await writeAtomic(gifPath, async out => {
    if (attachmentType === 'video') {
      const seconds = (await getVideoMetadata(inputPath)).format.duration;
      if (seconds > MAX_GIF_DURATION && !adminUser) {
        throw new ValidationError(
          `video is too long (${Math.ceil(seconds)}s). maximum duration: ${MAX_GIF_DURATION}s`
        );
      }
      const conversionOptions = resolveVideoConversionOptions(
        options,
        await probeMediaInfo(inputPath, 480)
      );
      const { startTime, duration } = conversionOptions;
      if (seconds && startTime !== null && duration !== null && startTime + duration > seconds) {
        throw new ValidationError(
          `requested timeframe (${startTime}s to ${(startTime + duration).toFixed(1)}s) exceeds video length (${seconds.toFixed(1)}s).`
        );
      }
      await convertToGif(inputPath, out, conversionOptions);
    } else if (attachment.contentType === 'image/gif' || ext === '.gif') {
      if (options.width) {
        await convertImageToGif(inputPath, out, {
          width: options.width,
        });
      } else {
        await fs.copyFile(inputPath, out);
      }
    } else if (isAnimatedWebp(file.head)) {
      // ffmpeg can't demux animated webp (e.g. TikTok stickers), so ImageMagick converts it.
      await convertAnimatedWebpToGif(inputPath, out, { width: options.width });
    } else {
      const { width } = await probeMediaInfo(inputPath, 720);
      await convertImageToGif(inputPath, out, {
        width: options.width ?? width,
      });
    }
  });
  logOperationStep(operationId, 'conversion_complete', 'success', {
    message: `${attachmentType} converted to GIF`,
  });
}

async function processConversion(
  interaction,
  attachment,
  attachmentType,
  adminUser,
  preDownloaded = null,
  options = {},
  originalUrl = null,
  commandSource = null
) {
  await runMediaCommand(
    'convert',
    interaction,
    async ctx => {
      const { operationId, userId } = ctx;
      const attachmentLimit = getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT);

      if (originalUrl) {
        const dbReady = await initializeDatabaseWithErrorHandling({
          operationId,
          userId,
          commandName: 'convert',
          interaction,
          context: { originalUrl },
        });
        if (!dbReady) return;
      }

      const urlHash = originalUrl ? hashUrlWithParams(originalUrl, options) : null;
      const cachedRow = urlHash ? await getProcessedUrl(urlHash) : null;
      const cachedGif = cachedRow?.file_type === 'gif' || cachedRow?.file_extension === '.gif';
      if (cachedGif && !cachedRow.r2_expired_at) {
        logOperationStep(operationId, 'url_cache_hit', 'success', {
          message: 'URL already converted, returning cached result',
          metadata: { originalUrl, cachedUrl: cachedRow.file_url },
        });
        await deliverReply(interaction, { content: cachedRow.file_url });
        return finishCommand('convert', ctx, 0);
      }

      const file =
        preDownloaded ||
        (attachmentType === 'video'
          ? await downloadVideo(attachment.url, adminUser)
          : await downloadImage(attachment.url, adminUser));

      // The gif is stored under its source and the options that shaped it, so a trimmed or
      // resized convert never reuses the plain one.
      const shape = [options.width, options.startTime, options.duration];
      const hash = shape.every(value => value == null)
        ? file.hash
        : hashPartsHex([file.hash, 'gif', ...shape.map(v => (v == null ? null : String(v)))]);
      const gifPath = mediaPath('gif', hash, '.gif', GIF_STORAGE_PATH);
      const lossy = options.lossy ?? null;
      const optimize = Boolean(options.optimize) || lossy !== null;

      let gif = await loadStoredGif(hash);
      if (!gif) {
        await renderGif(ctx, { attachment, attachmentType, adminUser, file, options, gifPath });
        gif = await fromPath(gifPath, { contentType: 'image/gif', filename: `${hash}.gif` });
      }

      let finalHash = hash;
      if (optimize) {
        const optimized = await optimizeCached(gif, lossy);
        logOperationStep(operationId, 'optimization_complete', 'success', {
          message: 'GIF optimized',
          metadata: { originalSize: gif.size, optimizedSize: optimized.file.size, lossy },
        });
        finalHash = optimized.hash;
        gif = optimized.file;
      }

      const stored = await storeMedia(
        { ...gif, filename: `${finalHash}.gif`, contentType: 'image/gif' },
        ctx,
        attachmentLimit,
        { hash: finalHash }
      );
      await deliverStored(interaction, ctx, stored, { urlHash: urlHash ?? finalHash });
      await finishCommand('convert', ctx, stored.size);
    },
    {
      commandSource,
      skipDbInit: true,
      errorFallback: 'an error occurred while converting the file.',
      context: {
        commandOptions: options,
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

const inputType = attachment =>
  ALLOWED_VIDEO_TYPES.includes(attachment.contentType)
    ? 'video'
    : ALLOWED_IMAGE_TYPES.includes(attachment.contentType)
      ? 'image'
      : null;

const attachmentJson = attachment =>
  attachment && {
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
  };

// The file (downloading a url) a convert was given, typed as video or image; replies and
// returns null when it cannot be converted.
async function resolveInput(interaction, { attachment, url, adminUser, commandSource }) {
  let file = null;
  let originalUrl = null;
  if (url) {
    try {
      ({ attachment, file, originalUrl } = await fetchUrlInput(url, adminUser, interaction.client));
    } catch (error) {
      await refuse(interaction, 'convert', {
        message: curatedErrorMessage(error, 'failed to download file from URL.'),
        cause: error,
        reason: 'url_download_failed',
        context: { originalUrl: url, commandSource },
        notify: true,
      });
      return null;
    }
  }
  const type = inputType(attachment);
  if (!type) {
    const { name, size, contentType } = attachment;
    await refuse(interaction, 'convert', {
      message: UNSUPPORTED_FORMAT,
      detail: `unsupported content type: ${contentType || 'unknown'}`,
      reason: 'unsupported_format',
      context: {
        originalUrl,
        attachment: { name, size, contentType, url: attachment.url },
        commandSource,
      },
      notify: true,
    });
    return null;
  }
  const validation =
    type === 'video'
      ? validateVideoAttachment(attachment, adminUser)
      : validateImageAttachment(attachment, adminUser);
  if (!validation.valid) {
    const { name, size, contentType } = attachment;
    await refuse(interaction, 'convert', {
      message: validation.error,
      reason: url ? null : 'invalid_attachment',
      context: { attachment: { name, size, contentType, url: attachment.url }, commandSource },
      notify: true,
    });
    return null;
  }
  return { attachment, file, originalUrl, type };
}

// The bot's half: checks that answer privately before anything is deferred or queued.
async function acceptInput(interaction, { attachment, url, adminUser, commandSource }) {
  if (!url)
    return (await resolveInput(interaction, { attachment, adminUser, commandSource })) !== null;
  const check = validateUrl(url);
  if (!check.valid) {
    await refuse(interaction, 'convert', {
      message: `invalid URL: ${check.error}`,
      reason: 'invalid_url',
      context: { originalUrl: url, commandSource },
      notify: true,
    });
  }
  return check.valid;
}

// The job half, run by a worker (or inline): fetch, then convert to gif or another format.
export async function runConvertJob(
  interaction,
  { attachment, url, format = 'gif', times = null, gifOptions = {}, commandSource }
) {
  const adminUser = isAdmin(interaction.user.id);
  const input = await resolveInput(interaction, { attachment, url, adminUser, commandSource });
  if (!input) return;
  // Start and end only mean something for a video.
  const trim = {
    startTime: input.type === 'video' ? (times?.startTime ?? null) : null,
    duration: input.type === 'video' ? (times?.duration ?? null) : null,
  };
  if (format !== 'gif') {
    await processFormatConversion(
      interaction,
      input.attachment,
      adminUser,
      input.file,
      format,
      trim,
      input.originalUrl,
      commandSource
    );
    return;
  }
  await processConversion(
    interaction,
    input.attachment,
    input.type,
    adminUser,
    input.file,
    { ...gifOptions, ...trim },
    input.originalUrl,
    commandSource
  );
}

export async function handleConvertContextMenu(interaction) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'convert to gif') {
    return;
  }
  const adminUser = isAdmin(interaction.user.id);
  const guard = { type: 'convert', action: 'converting another video or image' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource: 'context-menu' })) {
    return;
  }

  const { attachments, content } = interaction.targetMessage;
  const attachment =
    attachments.find(att => ALLOWED_VIDEO_TYPES.includes(att.contentType)) ??
    attachments.find(att => ALLOWED_IMAGE_TYPES.includes(att.contentType));
  const url = attachment ? null : firstUrlIn(content);
  if (!attachment && !url) {
    await refuse(interaction, 'convert', {
      message: 'no video or image attachment or URL found in this message.',
      reason: 'missing_input',
      context: { commandSource: 'context-menu' },
      notify: true,
    });
    return;
  }
  const commandSource = 'context-menu';
  if (!(await acceptInput(interaction, { attachment, url, adminUser, commandSource }))) return;
  await safeInteractionDeferReply(interaction);
  await dispatchMediaJob(interaction, 'convert', {
    attachment: attachmentJson(attachment),
    url,
    commandSource,
  });
}

export async function handleConvertCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);
  const commandSource = commandSourceOf(interaction);
  logger.debug(
    `User ${userId} initiated conversion via slash command${adminUser ? ' [ADMIN]' : ''}`
  );
  const guard = { type: 'convert', action: 'converting another video or image' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource })) {
    return;
  }

  const attachment = interaction.options.getAttachment('file');
  const rawUrl = interaction.options.getString('url');
  const url = firstUrlIn(rawUrl) ?? rawUrl;
  const format = interaction.options.getString('format') || 'gif';
  const times = await resolveTimeOptions(interaction, { type: 'convert' });
  if (times === null) {
    return;
  }

  const context = { commandSource };
  if (!attachment && !url) {
    const message =
      'please provide either a video/image attachment or a URL to a video/image file.';
    await refuse(interaction, 'convert', { message, reason: 'missing_input', context });
    return;
  }
  if (attachment && url) {
    const message = 'please provide either a file attachment or a URL, not both.';
    await refuse(interaction, 'convert', { message, reason: 'multiple_inputs', context });
    return;
  }

  if (!(await acceptInput(interaction, { attachment, url, adminUser, commandSource }))) return;
  await safeInteractionDeferReply(interaction);
  const lossy = interaction.options.getNumber('lossy');
  await dispatchMediaJob(interaction, 'convert', {
    attachment: attachmentJson(attachment),
    url,
    format,
    times: { startTime: times.startTime, duration: times.duration },
    gifOptions: {
      optimize: interaction.options.getBoolean('optimize') ?? false,
      lossy: lossy !== null ? lossy : undefined,
    },
    commandSource,
  });
}
