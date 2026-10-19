import { AppError, ValidationError } from '../../utils/errors.js';
import { downloadFileFromUrl, parseTenorUrl, TENOR_VIEW_URL } from '../../utils/file-downloader.js';
import {
  isDiscordCdnUrl,
  isDiscordMessageLink,
  DISCORD_MESSAGE_LINK_MESSAGE,
} from '../../utils/discord-cdn.js';
import { acquireMedia } from '../../core/acquire-media.js';
import { routeFor } from '../../core/sources.js';
import { canonicalizeMirrorUrl } from '../../utils/cobalt.js';

// Known sites take /download's path (yt-dlp with its session, site extractors); others are plain files.
async function fetchSource(link, client) {
  const url = canonicalizeMirrorUrl(link);
  const source = isDiscordCdnUrl(url) ? null : routeFor(url);
  if (!source || source.id === 'direct') {
    return downloadFileFromUrl(url, client);
  }
  const result = await acquireMedia(url, { client, urlOnly: false });
  if (result.kind === 'urls') return downloadFileFromUrl(result.urls[0].url);
  return Array.isArray(result.fileData) ? result.fileData[0] : result.fileData;
}

// The file behind a url option, as {attachment, file, originalUrl}.
export async function fetchUrlInput(url, client) {
  if (isDiscordMessageLink(url)) throw new ValidationError(DISCORD_MESSAGE_LINK_MESSAGE);
  let source = url;
  if (TENOR_VIEW_URL.test(url)) {
    try {
      source = await parseTenorUrl(url);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('failed to parse Tenor URL.');
    }
  }
  const file = await fetchSource(source, client);
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
