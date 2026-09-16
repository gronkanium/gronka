import axios from 'axios';
import fsSync from 'node:fs';
import { createLogger } from './logger.js';
import { NetworkError } from './errors.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('reddit');

// Reddit's .json API is 403 only anonymously; with the session cookie it answers 200, so the
// earlier HTML scraping was never necessary. It also cost us a real bug: the page carries the
// whole comment tree, and a regex over it downloaded commenters' images as if they were the
// post's. The API labels post media, gallery order and per-comment media separately.
const API_TIMEOUT_MS = 20000;

// Reddit is mostly a link aggregator, so a post's media often is not Reddit's at all. These are
// the offsite hosts worth handing back to the caller, which re-runs its own source selection on
// the target rather than duplicating the routing table here.
// Keep in step with what the pipeline can actually route: every host here must be matched by
// YTDLP_SITES, GALLERY_DL_SITES, a custom extractor, or cobalt, or the hand-off dead-ends.
const OFFSITE_HOSTS = [
  'redgifs.com',
  'imgur.com',
  'gfycat.com',
  'streamable.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'pornhub.com',
  'xvideos.com',
  'xhamster.com',
  'redtube.com',
  'kick.com',
  'twitch.tv',
  'medal.tv',
  'tenor.com',
  'soundcloud.com',
];

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

/**
 * The comment id when the link points at one comment rather than at the post.
 * Both shapes Reddit emits put it sixth: /r/<sub>/comments/<post>/<slug>/<comment> and
 * /r/<sub>/comments/<post>/comment/<comment>. A bare post link is shorter, so there is nothing
 * to confuse it with.
 */
export function commentIdFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[2] === 'comments' && segments.length >= 6 ? segments[5] : null;
  } catch {
    return null;
  }
}

// Appending .json to a /s/ share link lands on the subreddit, not the post, so it has to be
// followed first. HEAD is enough: the 301 names the canonical permalink, comment id included.
async function canonicalUrl(url) {
  if (!/^\/r\/[^/]+\/s\//.test(new URL(url).pathname)) {
    return url;
  }
  try {
    const response = await axios.head(url, {
      ...ssrfGuardedRequest(),
      timeout: API_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      headers: { 'User-Agent': USER_AGENT },
    });
    return response.headers.location || url;
  } catch (error) {
    logger.warn(`Could not resolve Reddit share link: ${error.message}`);
    return url;
  }
}

async function fetchListing(url) {
  const cookie = readSessionCookie();
  if (!cookie) {
    // Curated rather than internal: download.js only propagates a ValidationError out of the
    // resolver, and that is reserved for the disabled-source gate.
    throw new NetworkError('reddit downloads are unavailable right now');
  }

  // raw_json=1 stops Reddit html-escaping the urls it hands back, signatures included.
  const jsonUrl = `${url.split('?')[0].replace(/\/$/, '')}/.json?limit=100&raw_json=1`;
  try {
    const response = await axios.get(jsonUrl, {
      ...ssrfGuardedRequest(),
      responseType: 'json',
      timeout: API_TIMEOUT_MS,
      maxRedirects: 3,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Cookie: cookie },
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      throw new NetworkError(
        'this post is unavailable, it may be deleted or private',
        'CONTENT_GONE'
      );
    }
    if (status === 429) {
      throw new NetworkError('reddit is rate limiting downloads right now, try again shortly.');
    }
    if (status === 401 || status === 403) {
      logger.error(
        `Reddit refused the session cookie (HTTP ${status}), the reddit_session in the cookie file needs refreshing`
      );
      throw new NetworkError('reddit rejected our session');
    }
    logger.warn(`Reddit API request failed: ${error.message}`);
    throw new NetworkError('failed to reach reddit');
  }
}

const IMAGE_EXTENSIONS = {
  'image/jpg': 'jpg',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Download candidates for one media_metadata entry, best first.
 *
 * The entry's key is the i.redd.it basename, so the unsigned original rebuilds from the mime
 * type; the signed preview stays as the fallback because the original 404s for crossposts.
 * Giphy comment gifs are the exception: Reddit marks them `invalid` and hands back no url at
 * all, but the key carries giphy's own id, which is all the cdn path needs.
 */
function candidatesFor(id, entry) {
  const giphy = /^giphy\|(\w+)$/.exec(id);
  if (giphy) {
    return [`https://i.giphy.com/media/${giphy[1]}/giphy.gif`];
  }
  if (entry?.status !== 'valid') {
    return [];
  }
  if (entry.e === 'AnimatedImage') {
    return [entry.s?.gif, entry.s?.mp4].filter(Boolean);
  }
  if (entry.e !== 'Image') {
    return [];
  }
  const extension = IMAGE_EXTENSIONS[entry.m];
  return [extension && `https://i.redd.it/${id}.${extension}`, entry.s?.u].filter(Boolean);
}

function isOffsiteUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return OFFSITE_HOSTS.some(offsite => host === offsite || host.endsWith(`.${offsite}`));
  } catch {
    return false;
  }
}

function isRedditImageUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === 'i.redd.it' &&
      /\.(jpe?g|png|gif|webp)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function mediaOf(post, depth = 0) {
  const video = post?.media?.reddit_video;
  if (video?.hls_url || video?.fallback_url) {
    return { external: video.hls_url || video.fallback_url, images: [] };
  }

  if (post?.gallery_data?.items?.length) {
    const images = post.gallery_data.items
      .map(item => candidatesFor(item.media_id, post.media_metadata?.[item.media_id]))
      .filter(candidates => candidates.length > 0);
    if (images.length > 0) {
      return { external: null, images };
    }
  }

  const target = post?.url_overridden_by_dest || post?.url;
  if (isRedditImageUrl(target)) {
    return { external: null, images: [[target]] };
  }
  if (isOffsiteUrl(target)) {
    return { external: target, images: [] };
  }

  // A crosspost carries no media of its own, the post it quotes does.
  const parent = post?.crosspost_parent_list?.[0];
  return parent && depth === 0 ? mediaOf(parent, 1) : { external: null, images: [] };
}

/**
 * Where the linked media lives, in the order the caller should prefer:
 *   `external`, a v.redd.it manifest or an offsite host, handed back for the caller's own source
 *               selection to route (yt-dlp handles both).
 *   `images`, per-item download candidates for Reddit-hosted images.
 *
 * A link to one comment resolves to that comment's media and nothing else. A link to the post
 * resolves to the post's own media and never touches the comment tree.
 */
export function selectRedditMedia(listing, url) {
  const post = listing?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new NetworkError('this post is unavailable, it may be deleted or private');
  }

  const commentId = commentIdFromUrl(url);
  if (commentId) {
    const comment = listing?.[1]?.data?.children?.find(child => child.kind === 't1')?.data;
    const images = Object.entries(comment?.media_metadata || {})
      .map(([id, entry]) => candidatesFor(id, entry))
      .filter(candidates => candidates.length > 0);
    if (images.length > 0) {
      return { external: null, images };
    }
    logger.info(`Reddit comment ${commentId} carries no media, falling back to the post`);
  }

  const media = mediaOf(post);
  if (!media.external && media.images.length === 0 && post.removed_by_category) {
    throw new NetworkError('this post was removed and its media is gone', 'CONTENT_GONE');
  }
  return media;
}

export async function resolveRedditPost(url) {
  const canonical = await canonicalUrl(url);
  return selectRedditMedia(await fetchListing(canonical), canonical);
}
