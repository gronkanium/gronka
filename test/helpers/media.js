import fs from 'node:fs/promises';
import { fromPath, tempPath } from '../../src/utils/media-file.js';

// A media item holding `bytes`, the shape every producer returns.
export async function mediaFromBytes(bytes, meta = {}) {
  const file = await tempPath(meta.ext ?? '');
  await fs.writeFile(file, bytes);
  return fromPath(file, meta);
}
