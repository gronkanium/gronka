import { botConfig } from '../../utils/config.js';
import { AppError } from '../../utils/errors.js';
import { downloadFileFromUrl, parseTenorUrl } from '../../utils/file-downloader.js';
import { parseOwnCdnUrl } from '../../utils/gif-optimizer.js';
import { CONTENT_TYPES } from '../../utils/r2-storage.js';
import { mediaPath } from '../../utils/storage.js';
import { fromPath } from '../../utils/media-file.js';

const TENOR_VIEW_URL = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i;

// The file behind a url option, as {attachment, file, originalUrl}. A file on this instance's
// own CDN is read from disk and gets no originalUrl, since it is already a processed result.
export async function fetchUrlInput(url, adminUser, client) {
  const own = parseOwnCdnUrl(url);
  if (own) {
    const name = `${own.hash}${own.ext}`;
    const contentType = CONTENT_TYPES[own.ext];
    const file = await fromPath(mediaPath(own.type, own.hash, own.ext, botConfig.gifStoragePath), {
      contentType,
      filename: name,
    }).catch(() => null);
    if (file) {
      return { attachment: { url, name, size: file.size, contentType }, file, originalUrl: null };
    }
  }
  let source = url;
  if (TENOR_VIEW_URL.test(url)) {
    try {
      source = await parseTenorUrl(url);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('failed to parse Tenor URL.');
    }
  }
  const file = await downloadFileFromUrl(source, adminUser, client);
  return {
    attachment: {
      url: source,
      name: file.filename,
      size: file.size,
      contentType: file.contentType,
    },
    file,
    originalUrl: source,
  };
}
