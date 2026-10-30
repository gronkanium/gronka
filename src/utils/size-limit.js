import { botConfig } from './config.js';
import { createLogger } from './logger.js';
import { readSetting } from './settings.js';
import { ValidationError } from './errors.js';

const logger = createLogger('size-limit');
const MB = 1024 * 1024;

// The one size limit for every file the bot downloads or processes: the webui setting, else MAX_VIDEO_SIZE.
export async function maxDownloadBytes() {
  try {
    const mb = await readSetting('max_video_size_mb');
    return mb > 0 ? mb * MB : botConfig.maxVideoSize;
  } catch (error) {
    logger.warn(`Could not read max_video_size_mb, using MAX_VIDEO_SIZE: ${error.message}`);
    return botConfig.maxVideoSize;
  }
}

export const tooLarge = (limit, cause) =>
  new ValidationError(
    `this file is over the ${Math.floor(limit / MB)}MB limit. for a video, the start and end options can grab a clip under it.`,
    'TOO_LARGE',
    413,
    cause === undefined ? undefined : { cause }
  );
