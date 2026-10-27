import { ValidationError } from '../../utils/errors.js';
import { downloadFileFromUrl, downloadDirectMedia } from '../../utils/file-downloader.js';
import {
  isDiscordCdnUrl,
  isDiscordMessageLink,
  DISCORD_MESSAGE_LINK_MESSAGE,
} from '../../utils/discord-cdn.js';
import { acquireMedia } from '../../core/acquire-media.js';
import { routeFor } from '../../core/sources.js';
import { readLink, prepareLink } from '../../core/intake.js';

// Known sites take /download's path (yt-dlp with its session, site extractors); others are plain files.
async function fetchLink(url, client) {
  const source = isDiscordCdnUrl(url) ? null : routeFor(url);
  if (!source || source.id === 'direct') {
    return downloadDirectMedia(url, client);
  }
  const result = await acquireMedia(url, { client, urlOnly: false });
  if (result.kind === 'urls') return downloadDirectMedia(result.urls[0].url);
  return Array.isArray(result.fileData) ? result.fileData[0] : result.fileData;
}

// The one way /convert and /optimize get their input, as {attachment, file, originalUrl}.
export async function fetchInput({ attachment, url }, client) {
  if (attachment) {
    return {
      attachment,
      file: await downloadFileFromUrl(attachment.url, client),
      originalUrl: null,
    };
  }
  const { url: link, refusal } = readLink(url);
  if (refusal) throw new ValidationError(refusal.message);
  if (isDiscordMessageLink(link)) throw new ValidationError(DISCORD_MESSAGE_LINK_MESSAGE);
  const source = await prepareLink(link);
  const file = await fetchLink(source, client);
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
