import { ValidationError } from '../../utils/errors.js';
import { downloadFileFromUrl } from '../../utils/file-downloader.js';
import {
  isDiscordCdnUrl,
  isDiscordMessageLink,
  DISCORD_MESSAGE_LINK_MESSAGE,
} from '../../utils/discord-cdn.js';
import { acquireMedia } from '../../core/acquire-media.js';
import { routeFor } from '../../core/sources.js';
import { readLink, prepareLink } from '../../core/intake.js';

// Known sites take /download's path (yt-dlp with its session, site extractors); others are plain files.
async function fetchSource(url, client) {
  const source = isDiscordCdnUrl(url) ? null : routeFor(url);
  if (!source || source.id === 'direct') {
    return downloadFileFromUrl(url, client);
  }
  const result = await acquireMedia(url, { client, urlOnly: false });
  if (result.kind === 'urls') return downloadFileFromUrl(result.urls[0].url);
  return Array.isArray(result.fileData) ? result.fileData[0] : result.fileData;
}

// The file behind a url option, as {attachment, file, originalUrl}.
export async function fetchUrlInput(text, client) {
  const { url, refusal } = readLink(text);
  if (refusal) throw new ValidationError(refusal.message);
  if (isDiscordMessageLink(url)) throw new ValidationError(DISCORD_MESSAGE_LINK_MESSAGE);
  const source = await prepareLink(url);
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
