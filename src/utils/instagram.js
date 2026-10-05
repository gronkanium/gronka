import axios from 'axios';
import { readSessionCookie } from './session-cookie.js';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';
import { normalizeHost } from './url-host.js';

const logger = createLogger('instagram');

// Cobalt 11 answers error.api.fetch.empty for every /p/ permalink, and yt-dlp's Instagram
// extractor only ever returns video, so an image post fails there as "no video in it", the
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
const ASBD_ID = '129477'; // the web client's constant; it does not vary per session
const API_TIMEOUT_MS = 20000;

// Instagram hands back a rolling x-ig-set-www-claim and expects it echoed on the next call.
// Starting at '0' is what a fresh browser tab sends; never advancing it marks us as a bot.
let wwwClaim = '0';
const MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

// The share sheet emits /<username>/p/<code> as often as the bare /p/<code>.
const POST_PATH = /^(?:\/[^/]+)?\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

// Shortcodes are the media id written in this base64 alphabet, so the id is recoverable
// locally, no extra lookup request just to turn a permalink into an api id.
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Must match the browser that holds the session (ig-session), or one sessionid shows two devices.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/153.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Chromium";v="153", "Not_A Brand";v="8"';

// /stories/<user>/[<mediaId>], /stories/highlights/<id>, and the share sheet's /s/<base64 highlight:<id>>.
const STORY_PATH = /^\/stories\/(?:highlights\/(\d+)|(?!highlights(?:\/|$))([^/]+)(?:\/(\d+))?)/;
// Reel feeds and username search answer on the web host only some of the time; i. is what yt-dlp uses.
const REELS_HOST = 'i.instagram.com';
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]+)/;
const MAX_HIGHLIGHT_ITEMS = 10;

function isInstagramHost(hostname) {
  const host = normalizeHost(hostname);
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

/** {highlightId, username, mediaId} for a story or highlight link (each may be null), else null. */
export function parseStoryUrl(url) {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    if (!isInstagramHost(hostname)) {
      return null;
    }
    const story = pathname.match(STORY_PATH);
    if (story) {
      return {
        highlightId: story[1] ?? null,
        username: story[2] ?? null,
        mediaId: story[3] ?? null,
      };
    }
    const share = pathname.match(SHARE_PATH);
    const decoded = share && Buffer.from(share[1], 'base64url').toString('utf8');
    const highlightId = decoded?.match(/^highlight:(\d+)$/)?.[1];
    if (!highlightId) {
      return null;
    }
    const mediaId = searchParams.get('story_media_id');
    return { highlightId, username: null, mediaId: /^\d+$/.test(mediaId ?? '') ? mediaId : null };
  } catch {
    return null;
  }
}

export function isInstagramStoryUrl(url) {
  return parseStoryUrl(url) !== null;
}

/** True for an Instagram post permalink (/p/, /reel/, /reels/, /tv/) on any instagram host. */
export function isInstagramPostUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = normalizeHost(hostname);
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

export const readCookie = () => readSessionCookie('instagram', 'sessionid=');

/** Whether the Instagram extractor is usable at all; false means the caller should use cobalt. */
export function hasInstagramSession() {
  return readCookie() !== null;
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

export async function instagramGet(
  apiPath,
  refererPath,
  cookie,
  unavailable = 'post',
  host = 'www.instagram.com'
) {
  let response;
  try {
    response = await axios.get(`https://${host}${apiPath}`, {
      ...ssrfGuardedRequest(),
      responseType: 'json',
      timeout: API_TIMEOUT_MS,
      maxRedirects: 0,
      headers: {
        'User-Agent': USER_AGENT,
        'Sec-CH-UA': SEC_CH_UA,
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Linux"',
        'X-IG-App-ID': APP_ID,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        // The web client sends all of these; a bare request is an obvious bot and is what
        // gets a session flagged for "suspicious automated activity".
        'X-IG-WWW-Claim': wwwClaim,
        'X-ASBD-ID': ASBD_ID,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `https://www.instagram.com${refererPath}`,
        Origin: 'https://www.instagram.com',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        Cookie: cookie,
      },
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 404) {
      throw new NetworkError(unavailableMessage(unavailable), 'CONTENT_GONE');
    }
    // A dead session answers 401/403 on every post, so it reads as "everything is broken"
    // rather than "one post is missing". Say so in the log; the user still gets the curated
    // error from whatever the caller falls back to.
    // An expired sessionid usually 302s to /accounts/login/ instead of answering 401, hence
    // maxRedirects: 0, so that lands here rather than as a generic redirect-loop error.
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      logger.error(
        'Instagram rejected the session cookie (HTTP ' +
          status +
          '), the sessionid in the cookie file needs refreshing'
      );
      throw new NetworkError('instagram rejected our session');
    }
    if (status === 429) {
      throw new NetworkError('instagram is rate limiting downloads right now');
    }
    const reason = status ? `HTTP ${status}` : error.code || error.message;
    logger.warn(`Instagram ${host}${apiPath.split('?')[0]} failed (${reason})`);
    throw new NetworkError('failed to reach instagram');
  }

  wwwClaim = response.headers?.['x-ig-set-www-claim'] || wwwClaim;
  return response.data;
}

function unavailableMessage(kind) {
  return kind === 'story'
    ? 'this story is unavailable, it may have expired (stories last 24 hours) or be private'
    : 'this post is unavailable, it may be deleted or private';
}

const storyGone = () => new NetworkError(unavailableMessage('story'), 'CONTENT_GONE');

async function userIdFor(username, refererPath, cookie) {
  const query = `context=blended&query=${encodeURIComponent(username)}&include_reel=true&search_surface=web_top_search`;
  const data = await instagramGet(
    `/api/v1/web/search/topsearch/?${query}`,
    refererPath,
    cookie,
    'story'
  );
  const match = data?.users?.find(
    entry => entry?.user?.username?.toLowerCase() === username.toLowerCase()
  );
  if (!match?.user?.pk) {
    throw storyGone();
  }
  return String(match.user.pk);
}

async function reelItems(reelId, refererPath, cookie) {
  const data = await instagramGet(
    `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`,
    refererPath,
    cookie,
    'story',
    REELS_HOST
  );
  return data?.reels?.[reelId]?.items ?? data?.reels_media?.[0]?.items ?? [];
}

async function fetchStoryItems({ highlightId, username, mediaId }, refererPath, cookie) {
  if (mediaId) {
    try {
      const item = (
        await instagramGet(`/api/v1/media/${mediaId}/info/`, refererPath, cookie, 'story')
      )?.items?.[0];
      if (item) {
        return [item];
      }
    } catch (error) {
      if (!highlightId && !username) {
        throw error;
      }
    }
  }
  if (!highlightId && !username) {
    throw storyGone();
  }
  const reelId = highlightId
    ? `highlight:${highlightId}`
    : await userIdFor(username, refererPath, cookie);
  const items = await reelItems(reelId, refererPath, cookie);
  const wanted = mediaId ? items.filter(item => String(item.pk) === mediaId) : items;
  if (wanted.length === 0) {
    throw storyGone();
  }
  return wanted.slice(0, MAX_HIGHLIGHT_ITEMS);
}

// Download the media behind an Instagram post URL via the web client's media-info API
export async function downloadFromInstagram(url) {
  const cookie = readCookie();
  if (!cookie) {
    throw new ValidationError('no instagram session configured');
  }

  const parsed = new URL(url);

  const story = parseStoryUrl(url);
  if (story) {
    logger.debug(
      `Resolving Instagram story (highlight ${story.highlightId}, media ${story.mediaId})`
    );
    const items = await fetchStoryItems(story, parsed.pathname, cookie);
    const downloaded = (
      await Promise.all(
        items.map(async item => {
          const mediaUrl = selectMediaUrl(item);
          if (!mediaUrl) {
            return null;
          }
          return downloadFileFromUrl(mediaUrl).catch(error => {
            logger.warn(`Instagram story item failed: ${error.message}`);
            return null;
          });
        })
      )
    ).filter(Boolean);
    if (downloaded.length === 0) {
      throw new ValidationError('no downloadable media found on this story');
    }
    return downloaded.length === 1 ? downloaded[0] : downloaded;
  }

  const shortcode = parsed.pathname.match(POST_PATH)?.[1];
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) {
    throw new ValidationError('could not read the post id from this instagram link');
  }

  const imgIndexParam = Number.parseInt(parsed.searchParams.get('img_index') ?? '', 10);
  const imgIndex = Number.isNaN(imgIndexParam) ? null : imgIndexParam;

  logger.debug(`Resolving Instagram post ${shortcode} (media ${mediaId})`);

  const data = await instagramGet(`/api/v1/media/${mediaId}/info/`, parsed.pathname, cookie);

  const media = data?.items?.[0];
  if (!media) {
    throw new NetworkError('this post is unavailable, it may be deleted or private');
  }

  const mediaUrl = selectMediaUrl(media, imgIndex);
  if (!mediaUrl) {
    throw new ValidationError('no downloadable media found on this post');
  }

  const result = await downloadFileFromUrl(mediaUrl);
  logger.debug(
    `Downloaded Instagram media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
