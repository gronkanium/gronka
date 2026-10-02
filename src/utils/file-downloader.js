import axios from 'axios';
import path from 'path';
import { createLogger } from './logger.js';
import { botConfig } from './config.js';
import { validateUrl } from './validation.js';
import { ValidationError, NetworkError } from './errors.js';
import { isSocialMediaUrl, downloadFromSocialMedia } from './cobalt.js';
import { isInstagramStoryUrl, hasInstagramSession, downloadFromInstagram } from './instagram.js';
import { isDiscordCdnUrl, getRefreshedAttachmentURL, getRequestHeaders } from './discord-cdn.js';
import { sanitizeFilename } from './validation.js';
import { fetchToFile, withExtension } from './media-file.js';
import {
  BLOCKED_DESTINATION_MESSAGE,
  isSsrfBlockedError,
  ssrfGuardedRequest,
  MAX_PAGE_BYTES,
} from './ssrf-guard.js';
import { isMegaUrl, downloadFromMega } from './mega.js';

const logger = createLogger('file-downloader');

// Extension only picks the route; isMediaResponse re-checks what actually came back.
const DIRECT_MEDIA_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'avi',
  'mkv',
  'gif',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
]);

export function isDirectMediaUrl(url) {
  if (isMegaUrl(url)) return true;
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    return DIRECT_MEDIA_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

export function isMediaResponse(contentType, head) {
  const type = (contentType || '').toLowerCase();
  if (type.startsWith('video/') || type.startsWith('image/')) {
    return true;
  }
  // An explicit non-media type is a real answer; only sniff when it's absent or generic.
  if (type && !type.startsWith('application/octet-stream') && !type.startsWith('binary/')) {
    return false;
  }
  if (!head || head.length < 12) {
    return false;
  }
  const latin = head.subarray(0, 12).toString('latin1');
  return (
    latin.startsWith('GIF87a') ||
    latin.startsWith('GIF89a') ||
    head.subarray(4, 8).toString('latin1') === 'ftyp' ||
    latin.startsWith('\x89PNG\r\n\x1a\n') ||
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (latin.startsWith('RIFF') && head.subarray(8, 12).toString('latin1') === 'WEBP') ||
    latin.startsWith('\x1aE\xdf\xa3')
  );
}

// Reuses /convert's guarded fetch rather than adding a second one.
export async function downloadDirectMedia(url, isAdminUser = false, client = null, options = {}) {
  const fileData = await downloadFileFromUrl(url, isAdminUser, client, options);
  if (!isMediaResponse(fileData.contentType, fileData.head)) {
    logger.warn(
      `Direct media URL returned non-media content: ${url} (content-type: ${fileData.contentType || 'none'})`
    );
    throw new ValidationError('that link does not point to a video or image file.');
  }
  return fileData;
}

// A 413, or our own cap tripping mid-stream.
function isTooLargeError(error) {
  return error?.response?.status === 413 || error?.code === 'TOO_LARGE';
}

const {
  maxVideoSize: MAX_VIDEO_SIZE,
  maxImageSize: MAX_IMAGE_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
} = botConfig;
const MAX_ANY_SIZE = Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE);
const mb = bytes => bytes / (1024 * 1024);

function guardedFetch(url, maxSize, userAgent = null) {
  return fetchToFile(
    url,
    {
      ...ssrfGuardedRequest(),
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: userAgent
        ? { ...getRequestHeaders(), 'User-Agent': userAgent }
        : getRequestHeaders(),
    },
    { maxSize }
  );
}

function filenameFor(file, url) {
  const match = (file.headers['content-disposition'] || '').match(
    /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
  );
  if (match?.[1]) return sanitizeFilename(match[1].replace(/['"]/g, ''));
  try {
    const name = path.basename(new URL(url).pathname);
    if (name && name !== '/') return sanitizeFilename(name);
  } catch {
    // keep the default
  }
  return 'file';
}

async function downloadCapped(url, isAdminUser, maxSize, kind) {
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(urlValidation.error);
  }
  try {
    const file = await guardedFetch(url, isAdminUser ? Infinity : maxSize);
    return await withExtension({ ...file, filename: filenameFor(file, url) });
  } catch (error) {
    if (isSsrfBlockedError(error)) {
      throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
    }
    if (isTooLargeError(error) && !isAdminUser) {
      throw new ValidationError(`${kind} file is too large (max ${mb(maxSize)}mb)`);
    }
    logger.warn(`${kind} download failed: ${error.message}`);
    throw new NetworkError(`failed to download the ${kind}. it may be unavailable.`);
  }
}

export function downloadVideo(url, isAdminUser = false) {
  return downloadCapped(url, isAdminUser, MAX_VIDEO_SIZE, 'video');
}

export function downloadImage(url, isAdminUser = false) {
  return downloadCapped(url, isAdminUser, MAX_IMAGE_SIZE, 'image');
}

async function fetchAnyFile(url, isAdminUser, userAgent) {
  const file = await guardedFetch(url, isAdminUser ? Infinity : MAX_ANY_SIZE, userAgent);
  const contentType = file.headers['content-type'] || '';
  const isImage =
    !contentType.includes('video') &&
    (contentType.includes('image') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url));
  if (!isAdminUser && isImage && file.size > MAX_IMAGE_SIZE) {
    throw new ValidationError(`file is too large (max ${mb(MAX_IMAGE_SIZE)}mb for images)`);
  }
  return withExtension({ ...file, contentType, filename: filenameFor(file, url) });
}

export async function downloadFileFromUrl(url, isAdminUser = false, client = null, options = {}) {
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(urlValidation.error);
  }

  let actualUrl = url;
  if (client && isDiscordCdnUrl(url)) {
    try {
      actualUrl = await getRefreshedAttachmentURL(client, url);
      if (actualUrl !== url) {
        logger.debug(`Using refreshed URL for Discord CDN attachment`);
      }
    } catch (error) {
      logger.warn(`Failed to refresh Discord URL, using original: ${error.message}`);
    }
  }

  if (isMegaUrl(actualUrl)) {
    return downloadFromMega(actualUrl, isAdminUser, MAX_ANY_SIZE);
  }

  if (isInstagramStoryUrl(actualUrl) && hasInstagramSession()) {
    const story = await downloadFromInstagram(actualUrl, isAdminUser);
    return Array.isArray(story) ? story[0] : story;
  }

  // Skip Cobalt for Discord CDN URLs as they are handled directly
  if (COBALT_ENABLED && !isDiscordCdnUrl(actualUrl) && isSocialMediaUrl(actualUrl)) {
    try {
      logger.debug(`Detected social media URL, attempting download via Cobalt`);
      const maxSize = isAdminUser ? Infinity : MAX_VIDEO_SIZE;
      return await downloadFromSocialMedia(COBALT_API_URL, actualUrl, isAdminUser, maxSize);
    } catch (cobaltError) {
      logger.warn(
        `Cobalt download failed, falling back to direct download: ${cobaltError.message}`
      );
    }
  }

  try {
    return await fetchAnyFile(actualUrl, isAdminUser, options.userAgent);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (isSsrfBlockedError(error)) {
      throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
    }
    if (isTooLargeError(error) && !isAdminUser) {
      throw new ValidationError(
        `file is too large (max ${mb(MAX_VIDEO_SIZE)}mb for videos, ${mb(MAX_IMAGE_SIZE)}mb for images)`
      );
    }
    if (error.response?.status === 404) {
      throw new NetworkError('file not found at the provided URL');
    }
    if (error.response?.status === 403) {
      throw new NetworkError(
        'access denied to the file URL (may be expired or require authentication)'
      );
    }
    if (error.response?.status === 401) {
      throw new NetworkError('authentication required to access the file URL');
    }
    if (error.response?.status === 500 && isDiscordCdnUrl(url) && client && actualUrl === url) {
      try {
        logger.debug(`Got 500 error, attempting to refresh Discord URL`);
        const refreshedUrl = await getRefreshedAttachmentURL(client, url);
        if (refreshedUrl !== url) {
          logger.debug(`Retrying download with refreshed URL`);
          return await fetchAnyFile(refreshedUrl, isAdminUser);
        }
      } catch (refreshError) {
        if (refreshError instanceof ValidationError) throw refreshError;
        logger.warn(`Failed to refresh and retry Discord URL: ${refreshError.message}`);
      }
      throw new NetworkError(
        'discord cdn returned an error. the url may be expired or invalid. please try using a fresh url from discord.'
      );
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError('request timed out while downloading file');
    }
    logger.warn(`File download from URL failed: ${error.message}`);
    throw new NetworkError('failed to download the file from the provided url.');
  }
}

export const TENOR_VIEW_URL = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-(\d+)/i;

export async function parseTenorUrl(url) {
  try {
    const match = url.match(TENOR_VIEW_URL);

    if (!match) {
      throw new ValidationError('invalid Tenor URL format');
    }

    const gifId = match[2];
    logger.debug(`Parsing Tenor URL, extracted GIF ID: ${gifId}`);

    // Try to fetch the page and parse meta tags
    try {
      const headers = getRequestHeaders();
      // Remove Discord referer for Tenor URLs
      delete headers.Referer;
      const response = await axios.get(url, {
        ...ssrfGuardedRequest(),
        timeout: 30000,
        maxContentLength: MAX_PAGE_BYTES,
        maxRedirects: 5,
        headers,
      });

      const html = response.data;

      // Match script tag with id="store-cache" (attributes can be in any order)
      const storeCacheMatch = html.match(
        /<script[^>]*id=["']store-cache["'][^>]*>(.*?)<\/script>/is
      );
      if (storeCacheMatch && storeCacheMatch[1]) {
        try {
          const storeData = JSON.parse(storeCacheMatch[1]);
          // Navigate to gifs.byId[gifId].results[0].media_formats.gif.url
          if (
            storeData.gifs &&
            storeData.gifs.byId &&
            storeData.gifs.byId[gifId] &&
            storeData.gifs.byId[gifId].results &&
            storeData.gifs.byId[gifId].results[0] &&
            storeData.gifs.byId[gifId].results[0].media_formats &&
            storeData.gifs.byId[gifId].results[0].media_formats.gif &&
            storeData.gifs.byId[gifId].results[0].media_formats.gif.url
          ) {
            const gifUrl = storeData.gifs.byId[gifId].results[0].media_formats.gif.url;
            logger.debug(`Found GIF URL from store-cache JSON: ${gifUrl}`);
            return gifUrl;
          }
        } catch (error) {
          logger.warn(`Failed to parse store-cache JSON: ${error.message}`);
        }
      }

      const ogImageMatch = html.match(
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
      );
      if (ogImageMatch && ogImageMatch[1]) {
        const gifUrl = ogImageMatch[1];
        logger.debug(`Found GIF URL from og:image meta tag: ${gifUrl}`);
        return gifUrl;
      }

      const metaImageMatch = html.match(/<meta\s+name=["']image["']\s+content=["']([^"']+)["']/i);
      if (metaImageMatch && metaImageMatch[1]) {
        const gifUrl = metaImageMatch[1];
        logger.debug(`Found GIF URL from image meta tag: ${gifUrl}`);
        return gifUrl;
      }

      const jsonLdMatch = html.match(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/is
      );
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          if (jsonLd.image && typeof jsonLd.image === 'string') {
            logger.debug(`Found GIF URL from JSON-LD: ${jsonLd.image}`);
            return jsonLd.image;
          }
          if (jsonLd.image && jsonLd.image.url) {
            logger.debug(`Found GIF URL from JSON-LD image object: ${jsonLd.image.url}`);
            return jsonLd.image.url;
          }
        } catch {
          // Ignore JSON parsing errors
        }
      }
    } catch (error) {
      logger.warn(
        `Failed to parse Tenor page HTML: ${error.message}, falling back to direct URL pattern`
      );
    }

    const directUrl = `https://c.tenor.com/${gifId}/tenor.gif`;
    logger.debug(`Using fallback direct URL pattern: ${directUrl}`);
    return directUrl;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    logger.warn(`Tenor URL parse failed: ${error.message}`);
    throw new NetworkError('failed to parse the tenor url.');
  }
}
