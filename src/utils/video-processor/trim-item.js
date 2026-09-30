import path from 'node:path';
import { createLogger } from '../logger.js';
import { detectFileType } from '../storage.js';
import { fromPath, tempPath } from '../media-file.js';
import { trimVideo } from './trim-video.js';
import { trimGif } from './trim-gif.js';

const logger = createLogger('trim-item');

// Cuts a media file; returns the same item when it cannot.
export async function trimItem(item, { startTime, duration }) {
  const ext = path.extname(item.filename ?? '').toLowerCase();
  const kind = detectFileType(ext, item.contentType, item.head);
  const gif = kind === 'gif' || ext === '.gif';
  if (!gif && kind !== 'video') return item;
  try {
    const output = await tempPath(gif ? '.gif' : '.mp4');
    await (gif ? trimGif : trimVideo)(item.path, output, { startTime, duration });
    const base = path.parse(item.filename ?? 'video').name || 'video';
    return await fromPath(output, {
      filename: `${base}${gif ? '.gif' : '.mp4'}`,
      contentType: gif ? 'image/gif' : 'video/mp4',
    });
  } catch (error) {
    logger.warn(`Trim failed, serving untrimmed: ${error.message}`);
    return item;
  }
}
