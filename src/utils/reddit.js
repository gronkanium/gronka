import axios from 'axios';
import fsSync from 'node:fs';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('reddit');

// Reddit deprecated the unauthenticated .json endpoints in May 2026: appending .json now answers
// 403, and old.reddit.com serves the "Welcome to Reddit" interstitial, so yt-dlp's Reddit
// extractor cannot work from this box at all. The one surface that still answers in full is the
// normal www HTML with a logged-in session cookie, which embeds every image in src/srcset on
// <img class="media-lightbox-img"> — that is what this reads.
//
// Images only. v.redd.it serves video and audio as separate DASH streams that need an ffmpeg
// mux; those still fall through to cobalt/yt-dlp.
const PAGE_TIMEOUT_MS = 20000;
const MEDIA_HOSTS = ['i.redd.it', 'preview.redd.it'];

// /comments/<id>/... is the canonical form; /s/<id> is what the share sheet emits and 301s to it.
const POST_PATH = /^\/r\/[^/]+\/(?:comments|s)\/[A-Za-z0-9_]+/;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export function isRedditPostUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase().replace(/^www\./, '');
    return (host === 'reddit.com' || host.endsWith('.reddit.com')) && POST_PATH.test(pathname);
  } catch {
    return false;
  }
}

function readSessionCookie() {
  const cookiesPath = process.env.INSTAGRAM_COOKIES_PATH;
  if (!cookiesPath) {
    return null;
  }
  try {
    const entry = JSON.parse(fsSync.readFileSync(cookiesPath, 'utf8'))?.reddit?.[0];
    return typeof entry === 'string' && entry.includes('reddit_session=') ? entry : null;
  } catch (error) {
    logger.warn(`Could not read Reddit cookies from ${cookiesPath}: ${error.message}`);
    return null;
  }
}

/** Whether the Reddit extractor is usable at all; false means the caller should use cobalt. */
export function hasRedditSession() {
  return readSessionCookie() !== null;
}

function isMediaHostUrl(url) {
  try {
    return MEDIA_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Every candidate in a srcset, widest first. Reddit lists the same image at several widths and
 * each one carries its own `s=` signature, so a width cannot be swapped in by hand.
 */
function parseSrcset(srcset) {
  return srcset
    .split(',')
    .map(part => part.trim().split(/\s+/))
    .filter(([, w]) => /^\d+w$/.test(w || ''))
    .map(([url, w]) => ({ url, width: Number.parseInt(w, 10) }))
    .sort((a, b) => b.width - a.width);
}

/**
 * Post image URLs in page order, each the widest signed variant Reddit offered for it.
 * Keyed by image id so a gallery yields one entry per slide rather than one per width.
 */
export function extractImageUrls(html) {
  const decoded = html.replace(/&amp;/g, '&');
  const bySlide = new Map();

  for (const tag of decoded.matchAll(/<img\b[^>]*>/g)) {
    const markup = tag[0];
    if (!/media-lightbox-img|post-image/.test(markup)) {
      continue;
    }
    const srcset = markup.match(/\bsrcset="([^"]+)"/)?.[1];
    const src = markup.match(/\bsrc="([^"]+)"/)?.[1];
    const best = srcset ? parseSrcset(srcset).find(c => isMediaHostUrl(c.url))?.url : null;
    const chosen = best || (src && isMediaHostUrl(src) ? src : null);
    if (!chosen) {
      continue;
    }
    // preview and i.redd.it share the filename, so avatars/awards never collide with post media
    const id = new URL(chosen).pathname.split('/').pop().split('?')[0];
    if (!bySlide.has(id)) {
      bySlide.set(id, chosen);
    }
  }

  return [...bySlide.values()];
}

/**
 * Download an image from a Reddit post. Gallery posts resolve to their slides in page order;
 * `index` is 1-based to match the ?img_index= convention the share sheet uses elsewhere.
 * Throws on any failure; the caller treats that as "fall back to cobalt".
 */
export async function downloadFromReddit(url, isAdminUser = false, index = null) {
  const cookie = readSessionCookie();
  if (!cookie) {
    throw new ValidationError('no reddit session configured');
  }

  let response;
  try {
    response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_TIMEOUT_MS,
      maxRedirects: 3,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: cookie,
      },
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      throw new NetworkError('this post is unavailable — it may be deleted or private');
    }
    if (status === 403 || status === 429) {
      logger.error(
        `Reddit refused the session cookie (HTTP ${status}) — the reddit_session in the cookie file needs refreshing`
      );
      throw new NetworkError('reddit rejected our session');
    }
    logger.warn(`Reddit page request failed: ${error.message}`);
    throw new NetworkError('failed to reach reddit');
  }

  const html = String(response.data || '');
  if (/Welcome to Reddit/i.test(html.slice(0, 4000))) {
    throw new NetworkError('reddit served a login wall instead of the post');
  }

  const images = extractImageUrls(html);
  if (images.length === 0) {
    throw new ValidationError('no downloadable image found on this post');
  }

  const pick = Number.isInteger(index) && index >= 1 && index <= images.length ? index - 1 : 0;
  logger.info(`Resolved Reddit post to ${images.length} image(s), taking #${pick + 1}`);

  const result = await downloadFileFromUrl(images[pick], isAdminUser);
  logger.info(
    `Downloaded Reddit media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
