import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, firstUrlIn } from '../utils/validation.js';
import { curatedErrorMessage } from './shared/command-errors.js';
import {
  downloadVideo,
  downloadImage,
  downloadAudio,
  downloadDirectMedia,
} from '../utils/file-downloader.js';
import {
  attachmentMediaKind,
  validateConversionAttachment,
  firstConvertibleAttachment,
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
import { getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { optimizeToJob } from '../utils/gif-optimizer.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { sendConvertedFile } from './shared/send-converted.js';
import { ValidationError, withCause } from '../utils/errors.js';
import { resolveTimeOptions, refuse, commandSourceOf } from './shared/command-guards.js';
import { safeInteractionDeferReply } from '../utils/interaction-helpers.js';
import { storeMedia, deliverStored, finishCommand } from './shared/deliver.js';
import { fetchUrlInput } from './shared/url-input.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import { fromPath, tempPath, writeAtomic } from '../utils/media-file.js';
import { messageMediaInput } from './shared/message-media.js';
import { conversionInfo, compatibleFormats, conversionTrim } from '../utils/conversion-options.js';
import { waitForConvertFormat } from './convert-picker.js';

const logger = createLogger('convert');

const { discordSizeLimit: DISCORD_SIZE_LIMIT } = botConfig;

const UNSUPPORTED_FORMAT =
  'unsupported file format. please provide a video, audio file (mp3, m4a, ogg, wav, flac) or image (png, jpg, webp, gif).';

async function probeMediaInfo(filePath, fallbackWidth) {
  let width = fallbackWidth;
  let fps = 30;

  try {
    const metadata = await getVideoMetadata(filePath);
    const videoStream = metadata.streams?.find(
      s => s.codec_type === 'video' && !s.disposition?.attached_pic
    );
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
    videoIndex: options.videoIndex ?? null,
  };
}

async function processFormatConversion(
  interaction,
  attachment,
  preDownloaded,
  format,
  trim,
  originalUrl,
  commandSource = null,
  info = null
) {
  await runMediaCommand(
    'convert',
    interaction,
    async ctx => {
      const output = await convertToFormat(preDownloaded, format, {
        ...trim,
        videoIndex: info?.videoIndex ?? null,
        audioIndex: info?.audioIndex ?? null,
      });
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
      await finishCommand();
    },
    {
      commandSource,
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
async function renderGif(ctx, { attachment, attachmentType, file, options, gifPath }) {
  const ext = path.extname(attachment.name ?? '').toLowerCase();
  const inputPath = file.path;
  await fs.mkdir(path.dirname(gifPath), { recursive: true });

  await writeAtomic(gifPath, async out => {
    if (attachmentType === 'video' || options.startTime !== null || options.duration !== null) {
      const conversionOptions = resolveVideoConversionOptions(
        options,
        await probeMediaInfo(inputPath, 480)
      );
      await convertToGif(inputPath, out, conversionOptions);
    } else if (attachment.contentType === 'image/gif' || ext === '.gif') {
      if (options.width) {
        await convertImageToGif(inputPath, out, {
          width: options.width,
        });
      } else {
        await fs.copyFile(inputPath, out);
      }
    } else {
      const { width } = await probeMediaInfo(inputPath, 720);
      await convertImageToGif(inputPath, out, {
        width: options.width ?? width,
      });
    }
  });
}

async function processConversion(
  interaction,
  attachment,
  attachmentType,
  preDownloaded = null,
  options = {},
  originalUrl = null,
  commandSource = null
) {
  await runMediaCommand(
    'convert',
    interaction,
    async ctx => {
      const attachmentLimit = getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT);

      const file =
        preDownloaded ||
        (attachmentType === 'video'
          ? await downloadVideo(attachment.url)
          : await downloadImage(attachment.url));
      const gifPath = await tempPath('.gif');
      await renderGif(ctx, { attachment, attachmentType, file, options, gifPath });
      let gif = await fromPath(gifPath, { contentType: 'image/gif', filename: 'gronka.gif' });

      const lossy = options.lossy ?? null;
      if (options.optimize || lossy !== null) {
        const optimized = await optimizeToJob(gif, lossy);
        gif = optimized;
      }

      const stored = await storeMedia(gif, attachmentLimit);
      await deliverStored(interaction, stored);
      await finishCommand();
    },
    {
      commandSource,
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

const attachmentJson = attachment =>
  attachment && {
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
  };

async function resolveInput(interaction, { attachment, url, commandSource }) {
  let file = null;
  let originalUrl = null;
  if (url) {
    try {
      ({ attachment, file, originalUrl } = await fetchUrlInput(url, interaction.client));
    } catch (error) {
      await refuse(interaction, 'convert', {
        message: curatedErrorMessage(error, 'failed to download file from URL.'),
        cause: error,
        reason: 'url_download_failed',
        context: { originalUrl: url, commandSource },
      });
      return null;
    }
  }
  const type = attachmentMediaKind(attachment);
  if (!type) {
    const { name, size, contentType } = attachment;
    await refuse(interaction, 'convert', {
      message: UNSUPPORTED_FORMAT,
      detail: `unsupported content type: ${contentType || 'unknown'}`,
      reason: 'unsupported_format',
      context: {
        originalUrl: originalUrl ?? attachment.url,
        attachment: { name, size, contentType, url: attachment.url },
        commandSource,
      },
    });
    return null;
  }
  const validation = validateConversionAttachment(attachment);
  if (!validation.valid) {
    const { name, size, contentType } = attachment;
    await refuse(interaction, 'convert', {
      message: validation.error,
      reason: url ? null : 'invalid_attachment',
      context: {
        originalUrl: originalUrl ?? attachment.url,
        attachment: { name, size, contentType, url: attachment.url },
        commandSource,
      },
    });
    return null;
  }
  return { attachment, file, originalUrl, type };
}

// The bot's half: checks that answer privately before anything is deferred or queued.
async function acceptInput(interaction, { attachment, url, commandSource }) {
  if (!url) return (await resolveInput(interaction, { attachment, commandSource })) !== null;
  const check = validateUrl(url);
  if (!check.valid) {
    await refuse(interaction, 'convert', {
      message: `invalid URL: ${check.error}`,
      reason: 'invalid_url',
      context: { originalUrl: url, commandSource },
    });
  }
  return check.valid;
}

// The job half, run by a worker (or inline): fetch, then convert to gif or another format.
export async function runConvertJob(
  interaction,
  { attachment, url, format = 'gif', times = null, gifOptions = {}, commandSource, picker },
  jobId = null
) {
  const input = await resolveInput(interaction, { attachment, url, commandSource });
  if (!input) return;
  let info;
  let trim;
  try {
    const download =
      input.type === 'image'
        ? downloadImage
        : input.type === 'audio'
          ? downloadAudio
          : input.type === 'video'
            ? downloadVideo
            : downloadDirectMedia;
    input.file ??= await download(input.attachment.url, interaction.client);
    const sourceSize = input.file.size;
    if (isAnimatedWebp(input.file.head)) {
      if (sourceSize > botConfig.maxImageSize)
        throw new ValidationError(
          `that media file is too large (max ${botConfig.maxImageSize / 1024 / 1024}mb).`
        );
      const gifPath = await tempPath('.gif');
      await convertAnimatedWebpToGif(input.file.path, gifPath);
      input.file = await fromPath(gifPath, { contentType: 'image/gif', filename: 'animation.gif' });
      input.attachment = { ...input.attachment, contentType: 'image/gif' };
    }
    let metadata;
    try {
      metadata = await getVideoMetadata(input.file.path);
    } catch (error) {
      throw withCause(
        new ValidationError('could not read that media file. it may be damaged or unsupported.'),
        error
      );
    }
    info = { ...conversionInfo(metadata), filename: input.attachment.name };
    if (metadata.format?.format_name === 'gif') input.attachment.contentType = 'image/gif';
    const max = ['image', 'animation'].includes(info.kind)
      ? botConfig.maxImageSize
      : botConfig.maxVideoSize;
    if (sourceSize > max)
      throw new ValidationError(`that media file is too large (max ${max / 1024 / 1024}mb).`);
    trim = conversionTrim(info, times);
    if (picker) {
      const selected = await waitForConvertFormat(
        interaction,
        jobId,
        picker,
        compatibleFormats(info),
        info
      );
      if (!selected) return;
      ({ format, interaction } = selected);
    }
    if (!compatibleFormats(info).includes(format)) {
      throw new ValidationError(
        info.kind === 'audio'
          ? 'audio files can only be converted to mp3, m4a, ogg, wav or flac.'
          : OUTPUT_FORMATS[format]?.kind === 'audio'
            ? 'that file has no audio to extract.'
            : `cannot convert that file to ${format}.`
      );
    }
  } catch (error) {
    await refuse(interaction, 'convert', {
      message: curatedErrorMessage(error, 'could not prepare that file for conversion.'),
      cause: error,
      reason: 'conversion_input_failed',
      context: {
        originalUrl: url ?? input.attachment.url,
        commandSource,
        commandOptions: { format, ...times },
      },
    });
    return;
  }
  if (format !== 'gif') {
    await processFormatConversion(
      interaction,
      input.attachment,
      input.file,
      format,
      trim,
      input.originalUrl ?? input.attachment.url,
      commandSource,
      info
    );
    return;
  }
  await processConversion(
    interaction,
    input.attachment,
    info.kind === 'video' || info.demuxer === 'apng' ? 'video' : 'image',
    input.file,
    { ...gifOptions, ...trim, videoIndex: info.videoIndex },
    input.originalUrl ?? input.attachment.url,
    commandSource
  );
}

export async function handleConvertContextMenu(interaction) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'convert') {
    return;
  }

  const { attachment, url } = messageMediaInput(
    interaction.targetMessage,
    firstConvertibleAttachment
  );
  if (!attachment && !url) {
    await refuse(interaction, 'convert', {
      message: 'no video, audio or image attachment or URL found in this message.',
      reason: 'missing_input',
      context: { commandSource: 'context-menu' },
    });
    return;
  }
  const commandSource = 'context-menu';
  if (!(await acceptInput(interaction, { attachment, url, commandSource }))) return;
  await safeInteractionDeferReply(interaction, { flags: MessageFlags.Ephemeral });
  await queueConversion(interaction, {
    attachment: attachmentJson(attachment),
    url,
    commandSource,
    format: null,
    picker: { token: randomBytes(12).toString('hex') },
  });
}

export async function handleConvertCommand(interaction) {
  const commandSource = commandSourceOf(interaction);

  const attachment = interaction.options.getAttachment('file');
  const rawUrl = interaction.options.getString('url');
  const url = attachment ? null : (firstUrlIn(rawUrl) ?? rawUrl);
  const format = interaction.options.getString('format');
  const times = await resolveTimeOptions(interaction, { type: 'convert' });
  if (times === null) {
    return;
  }

  const context = { commandSource, originalUrl: url ?? attachment?.url };
  if (!attachment && !url) {
    const message = 'please provide a video, audio or image attachment, or a URL to a media file.';
    await refuse(interaction, 'convert', { message, reason: 'missing_input', context });
    return;
  }

  if (format !== null && format !== 'gif' && !OUTPUT_FORMATS[format]) {
    await refuse(interaction, 'convert', {
      message: 'that output format is not supported.',
      reason: 'unsupported_output',
      context,
    });
    return;
  }

  if (!(await acceptInput(interaction, { attachment, url, commandSource }))) return;
  await safeInteractionDeferReply(
    interaction,
    format === null ? { flags: MessageFlags.Ephemeral } : {}
  );
  const lossy = interaction.options.getNumber('lossy');
  await queueConversion(interaction, {
    attachment: attachmentJson(attachment),
    url,
    format,
    ...(format === null ? { picker: { token: randomBytes(12).toString('hex') } } : {}),
    times: { startTime: times.startTime, duration: times.duration },
    gifOptions: {
      optimize: interaction.options.getBoolean('optimize') ?? false,
      lossy: lossy !== null ? lossy : undefined,
    },
    commandSource,
  });
}

async function queueConversion(interaction, args) {
  try {
    await dispatchMediaJob(interaction, 'convert', args);
  } catch (error) {
    await refuse(interaction, 'convert', {
      message: curatedErrorMessage(error, 'could not start the conversion. please try again.'),
      cause: error,
      reason: 'conversion_queue_failed',
      context: {
        originalUrl: args.url ?? args.attachment?.url,
        commandSource: args.commandSource,
      },
    });
  }
}
