import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { detectFileType } from '../storage.js';
import { trimVideo } from './trim-video.js';
import { trimGif } from './trim-gif.js';

const logger = createLogger('trim-item');

// Cuts a downloaded {buffer, filename, contentType}; returns the same object when it cannot.
export async function trimItem(item, { startTime, duration }) {
  const ext = path.extname(item.filename ?? '').toLowerCase();
  const kind = detectFileType(ext, item.contentType, item.buffer);
  const gif = kind === 'gif' || ext === '.gif';
  if (!gif && kind !== 'video') return item;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trim-'));
  try {
    const input = path.join(dir, `in${ext || '.mp4'}`);
    const output = path.join(dir, gif ? 'out.gif' : 'out.mp4');
    await fs.writeFile(input, item.buffer, { mode: 0o600, flag: 'wx' });
    await (gif ? trimGif : trimVideo)(input, output, { startTime, duration });
    const buffer = await fs.readFile(output);
    const base = path.parse(item.filename ?? 'video').name || 'video';
    return {
      ...item,
      buffer,
      size: buffer.length,
      filename: `${base}${gif ? '.gif' : '.mp4'}`,
      contentType: gif ? 'image/gif' : 'video/mp4',
    };
  } catch (error) {
    logger.warn(`Trim failed, serving untrimmed: ${error.message}`);
    return item;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
