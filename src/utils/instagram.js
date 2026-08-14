import axios from 'axios';
import fsSync from 'node:fs';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('instagram');

// Cobalt 11 answers error.api.fetch.empty for every /p/ permalink, and yt-dlp's Instagram
// extractor only ever returns video, so an image post fails there as "no video in it" — the
// bot's single most common real error. Instagram's own web client does not read either of
// those surfaces: it calls /api/v1/media/<media_id>/info/ with the public web app id and the
// viewer's session cookie, and that route still returns the full media payload (images,
// videos, and carousels alike). This extractor calls exactly that route.
//
// It needs a logged-in sessionid; there is no anonymous form of this endpoint (without the
// cookie Instagram serves the client-rendered app shell, which contains no media at all).
// When no session is configured the caller falls back to cobalt, so self-hosters without
// cookies behave exactly as before.
const APP_ID = '936619743392459'; // the public web-client id instagram.com sends on its own calls
const API_TIMEOUT_MS = 20000;
const MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

const POST_PATH = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

// Shortcodes are the media id written in this base64 alphabet, so the id is recoverable
// locally — no extra lookup request just to turn a permalink into an api id.
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/** True for an Instagram post permalink (/p/, /reel/, /reels/, /tv/) on any instagram host. */
export function isInstagramPostUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase().replace(/^www\./, '');
    return (
      (host === 'instagram.com' || host.endsWith('.instagram.com')) && POST_PATH.test(pathname)
    );
  } catch {
    return false;
  }
}

export function shortcodeToMediaId(shortcode) {
  if (typeof shortcode !== 'string' || shortcode.length === 0) {
    return null;
  }
  let id = 0n;
  for (const char of shortcode) {
    const index = SHORTCODE_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    id = id * 64n + BigInt(index);
  }
  return id.toString();
}

/**
 * The `instagram` service cookie out of the cobalt cookie file, or null when none is usable.
 * Same file cobalt reads, so a refreshed session only has to be pasted in one place. Read per
 * call rather than memoized: refreshing an expired session must not need a container restart.
 */
function readSessionCookie() {
  const cookiesPath = process.env.INSTAGRAM_COOKIES_PATH;
  if (!cookiesPath) {
    return null;
  }
  try {
    if (!fsSync.statSync(cookiesPath).isFile()) {
      return null;
    }
    const entry = JSON.parse(fsSync.readFileSync(cookiesPath, 'utf8'))?.instagram?.[0];
    return typeof entry === 'string' && entry.includes('sessionid=') ? entry : null;
  } catch (error) {
    logger.warn(`Could not read Instagram cookies from ${cookiesPath}: ${error.message}`);
    return null;
  }
}

/** Whether the Instagram extractor is usable at all; false means the caller should use cobalt. */
export function hasInstagramSession() {
  return readSessionCookie() !== null;
}

function isMediaHostUrl(url) {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MEDIA_HOSTS.some(media => host === media || host.endsWith(`.${media}`));
  } catch {
    return false;
  }
}

/**
 * Pick the item a carousel URL points at. Instagram's own ?img_index= is 1-based and is what
 * the share sheet puts on a link to a specific slide; anything else falls back to the first.
 */
function selectCarouselItem(media, imgIndex) {
  const items = media?.carousel_media;
  if (!Array.isArray(items) || items.length === 0) {
    return media;
  }
  const index =
    Number.isInteger(imgIndex) && imgIndex >= 1 && imgIndex <= items.length ? imgIndex - 1 : 0;
  return items[index];
}

/**
 * Best media URL for a single item. Both candidate lists are ordered highest-quality-first.
 * Video wins over image because a video item also carries its own still frame.
 */
export function selectMediaUrl(media, imgIndex = null) {
  const item = selectCarouselItem(media, imgIndex);
  const video = item?.video_versions?.[0]?.url;
  if (isMediaHostUrl(video)) {
    return video;
  }
  const image = item?.image_versions2?.candidates?.[0]?.url;
  return isMediaHostUrl(image) ? image : null;
}

/**
 * Download the media behind an Instagram post URL via the web client's media-info API.
 * Returns the same { buffer, contentType, size, filename } shape as the other download paths.
 * Throws on any failure; the caller treats that as "fall back to cobalt".
 * @param {string} url - Instagram /p/, /reel/, /reels/ or /tv/ permalink
 * @param {boolean} isAdminUser - Admin users bypass size limits
 */
export async function downloadFromInstagram(url, isAdminUser = false) {
  const cookie = readSessionCookie();
  if (!cookie) {
    throw new ValidationError('no instagram session configured');
  }

  const parsed = new URL(url);
  const shortcode = parsed.pathname.match(POST_PATH)?.[1];
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) {
    throw new ValidationError('could not read the post id from this instagram link');
  }

  const imgIndexParam = Number.parseInt(parsed.searchParams.get('img_index') ?? '', 10);
  const imgIndex = Number.isNaN(imgIndexParam) ? null : imgIndexParam;

  logger.info(`Resolving Instagram post ${shortcode} (media ${mediaId})`);

  let response;
  try {
    response = await axios.get(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      ...ssrfGuardedRequest(),
      responseType: 'json',
      timeout: API_TIMEOUT_MS,
      maxRedirects: 3,
      headers: {
        'User-Agent': USER_AGENT,
        'X-IG-App-ID': APP_ID,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: cookie,
      },
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 404) {
      throw new NetworkError('this post is unavailable — it may be deleted or private');
    }
    // A dead session answers 401/403 on every post, so it reads as "everything is broken"
    // rather than "one post is missing". Say so in the log; the user still gets the curated
    // error from whatever the caller falls back to.
    if (status === 401 || status === 403) {
      logger.error(
        'Instagram rejected the session cookie (HTTP ' +
          status +
          ') — the sessionid in the cookie file needs refreshing'
      );
      throw new NetworkError('instagram rejected our session');
    }
    if (status === 429) {
      throw new NetworkError('instagram is rate limiting downloads right now');
    }
    logger.warn(`Instagram media-info request failed: ${error.message}`);
    throw new NetworkError('failed to reach instagram');
  }

  const media = response.data?.items?.[0];
  if (!media) {
    throw new NetworkError('this post is unavailable — it may be deleted or private');
  }

  const mediaUrl = selectMediaUrl(media, imgIndex);
  if (!mediaUrl) {
    throw new ValidationError('no downloadable media found on this post');
  }

  const result = await downloadFileFromUrl(mediaUrl, isAdminUser);
  logger.info(
    `Downloaded Instagram media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
