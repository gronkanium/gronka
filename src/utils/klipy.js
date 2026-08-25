import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('klipy');
const PAGE_FETCH_TIMEOUT_MS = 20000;
const KLIPY_HOST = /(^|\.)klipy\.com$/i;
const KLIPY_PAGE_PATH = /^\/(?:gifs?|stickers?|memes?)\//i;

export function isKlipyUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      (hostname === 'klipy.com' || hostname === 'www.klipy.com') && KLIPY_PAGE_PATH.test(pathname)
    );
  } catch {
    return false;
  }
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

function isKlipyMediaUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && KLIPY_HOST.test(hostname);
  } catch {
    return false;
  }
}

function candidateMediaUrl(value) {
  if (typeof value !== 'string') return null;
  const url = decodeHtml(value);
  return isKlipyMediaUrl(url) ? url : null;
}

// Klipy publishes ordinary Open Graph tags, but the exact tag name differs between GIF and
// sticker pages. JSON-LD is checked first so a page's poster image never wins over its video.
export function extractMediaUrl(html) {
  if (typeof html !== 'string' || html.length === 0) return null;

  let image = null;
  let gifImage = null;
  let video = null;
  for (const match of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        for (const key of ['contentUrl', 'video', 'image']) {
          const value = typeof item?.[key] === 'object' ? item[key].url : item?.[key];
          const url = candidateMediaUrl(value);
          if (url && key !== 'image') return url;
          if (!image && url && key === 'image') image = url;
        }
      }
    } catch {
      // Keep looking at the page metadata if one JSON-LD block is malformed.
    }
  }

  for (const match of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = match[0];
    const property = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    const url = candidateMediaUrl(content);
    if (!url) continue;
    if (
      property === 'og:video' ||
      property === 'og:video:url' ||
      property === 'og:video:secure_url'
    ) {
      if (!video) video = url;
    } else if (property === 'og:image' || property === 'twitter:image') {
      if (!image) image = url;
      if (!gifImage && /\.gif(?:[?#]|$)/i.test(new URL(url).pathname)) gifImage = url;
    }
  }

  // Klipy pages publish both an MP4 and an animated GIF. Preserve the source's GIF semantics;
  // converting that page to an MP4 makes downstream GIF handling and /optimize reject it.
  if (gifImage) return gifImage;
  if (video) return video;
  return image;
}

export async function downloadFromKlipy(url, isAdminUser = false) {
  logger.info(`Resolving Klipy page: ${url}`);
  let response;
  try {
    response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        ...getRequestHeaders(),
        // Klipy blocks generic browser user agents from data-center IPs; Discordbot is the
        // crawler identity it explicitly allows for link previews.
        'User-Agent': 'Discordbot/2.0',
      },
      validateStatus: status => status >= 200 && status < 400,
    });
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 410) {
      throw new NetworkError('this Klipy page is unavailable or has been deleted');
    }
    logger.warn(`Failed to fetch Klipy page: ${error.message}`);
    throw new NetworkError('failed to fetch the Klipy page');
  }

  const mediaUrl = extractMediaUrl(response.data);
  if (!mediaUrl) {
    logger.warn('No media found on Klipy page');
    throw new ValidationError('no downloadable media found on this Klipy page');
  }
  logger.info(`Extracted Klipy media URL: ${mediaUrl}`);
  return downloadFileFromUrl(mediaUrl, isAdminUser);
}
