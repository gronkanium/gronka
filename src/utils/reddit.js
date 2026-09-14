import axios from 'axios';
import fsSync from 'node:fs';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('reddit');

// Reddit deprecated the unauthenticated .json endpoints in May 2026: appending .json now answers
// 403, and old.reddit.com serves the "Welcome to Reddit" interstitial, so yt-dlp's Reddit
// extractor cannot work from this box at all. The one surface that still answers is the normal
// www HTML with a session cookie; see extractImageCandidates for the two shapes it comes in.
//
// Images only. v.redd.it serves video and audio as separate DASH streams that need an ffmpeg
// mux; those still fall through to cobalt/yt-dlp.
const PAGE_TIMEOUT_MS = 20000;
const MEDIA_HOSTS = ['i.redd.it', 'preview.redd.it'];

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

function isMediaHostUrl(url) {
  try {
    return MEDIA_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The trailing id both markup shapes share, after the title prefix the hydrated one adds. */
function slideId(url) {
  try {
    return new URL(url).pathname
      .split('/')
      .pop()
      .replace(/\.[^.]+$/, '')
      .split('-')
      .pop();
  } catch {
    return null;
  }
}

// Avatars, awards and static chrome live on the same hosts as post media.
const NON_POST_PATH = /snoovatar|\/award|\/cms\/|defaults|headshot/i;

/**
 * Per-slide download candidates, best first, slides in page order.
 *
 * Reddit serves two markup shapes for the same post and flips between them without warning: a
 * hydrated page with each slide in <img class="media-lightbox-img"> plus a srcset, and a
 * server-rendered one carrying only a 140px thumbnail per slide. Both name the slide's id, and
 * `i.redd.it/<id>.<ext>` is the unsigned original — anonymous, full resolution, and the only
 * thing available at all on the thumbnail-only pages. A signed `preview` variant is kept as the
 * fallback because the original 404s for crossposts; every width has its own `s=` signature, so
 * the widest has to be taken as-is rather than rewritten.
 */
export function extractImageCandidates(html) {
  const decoded = html.replace(/&amp;/g, '&');
  const slides = new Map();
  // og:image names the post's own first image, which is what distinguishes post media from the
  // thumbnails of neighbouring posts the server-rendered page also carries.
  const ogId = slideId(decoded.match(/property="og:image"\s+content="([^"]+)"/)?.[1]);

  for (const match of decoded.matchAll(/https:\/\/(?:preview|i)\.redd\.it\/[^"'\\\s<>)]+/g)) {
    const url = match[0];
    const ext = url.match(/\.(jpe?g|png|gif|webp)(?:\?|$)/i)?.[1];
    if (!ext || NON_POST_PATH.test(url) || !isMediaHostUrl(url)) {
      continue;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const id = slideId(url);
    if (!id) {
      continue;
    }
    const slide = slides.get(id) || { original: `https://i.redd.it/${id}.${ext}`, width: 0 };
    // Unsigned variants are listing thumbnails and 403, so only a signed one can be a fallback.
    const width = Number.parseInt(parsed.searchParams.get('width') || '0', 10);
    if (parsed.searchParams.has('s') && width > slide.width) {
      slide.width = width;
      slide.preview = url;
    }
    slides.set(id, slide);
  }

  const entries = [...slides.entries()];
  entries.sort(([a], [b]) => (a === ogId ? -1 : 0) - (b === ogId ? -1 : 0));
  return entries.map(([, slide]) => [slide.original, slide.preview].filter(Boolean));
}

async function fetchPostPage(url) {
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
  return html;
}

/** The post's offsite media link, if it points at a host the download pipeline already handles. */
export function extractOffsiteUrl(html) {
  const decoded = html.replace(/&amp;/g, '&');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    let host;
    try {
      host = new URL(match[0]).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (OFFSITE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
      return match[0];
    }
  }
  return null;
}

/** The v.redd.it HLS manifest for a post, which yt-dlp downloads and muxes on its own. */
export function extractVideoUrl(doc) {
  const id = doc.replace(/&amp;/g, '&').match(/https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/)?.[1];
  return id ? `https://v.redd.it/${id}/HLSPlaylist.m3u8` : null;
}

/**
 * The post's Atom feed. Unlike every other Reddit surface this still answers anonymously, and it
 * names the post's video id, its first image and any offsite link — so the session cookie is an
 * enhancement (it reads whole galleries out of the HTML) rather than a requirement.
 * Returns null rather than throwing: the caller falls back to the HTML.
 */
async function fetchPostFeed(url) {
  const feedUrl = `${url.split('?')[0].replace(/\/$/, '')}/.rss`;
  try {
    const response = await axios.get(feedUrl, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_TIMEOUT_MS,
      maxRedirects: 3,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml,application/xml' },
    });
    return String(response.data || '');
  } catch (error) {
    // 429 here is Reddit throttling the feed, which recovers on its own; nothing to escalate.
    logger.warn(`Reddit feed request failed (${error.response?.status || error.message})`);
    return null;
  }
}

/**
 * Where the post's media actually lives, in the order the caller should prefer:
 *   `external` — a v.redd.it HLS manifest or an offsite host, handed back for the caller's own
 *                source selection to route (yt-dlp handles both).
 *   `images`   — per-slide download candidates for Reddit-hosted images.
 *
 * Tries the anonymous feed first and only reads the cookie-gated HTML when it has to, which is
 * both fewer requests and the difference between working and not when the session expires.
 */
export async function resolveRedditPost(url) {
  const feed = await fetchPostFeed(url);

  if (feed) {
    const video = extractVideoUrl(feed);
    if (video) {
      return { external: video, images: [] };
    }
    const offsite = extractOffsiteUrl(feed);
    if (offsite) {
      return { external: offsite, images: [] };
    }
  }

  // The feed carries only the first image, so a gallery still needs the HTML. Without a session
  // the feed's single slide is all we get, which still beats failing outright.
  if (!hasRedditSession()) {
    const images = feed ? extractImageCandidates(feed) : [];
    return { external: null, images };
  }

  let html;
  try {
    html = await fetchPostPage(url);
  } catch (error) {
    const images = feed ? extractImageCandidates(feed) : [];
    if (images.length > 0) {
      logger.warn(`Reddit page failed (${error.message}); using the feed's first image`);
      return { external: null, images };
    }
    throw error;
  }

  const video = extractVideoUrl(html);
  if (video) {
    return { external: video, images: [] };
  }
  const images = extractImageCandidates(html);
  if (images.length > 0) {
    return { external: null, images };
  }
  return { external: extractOffsiteUrl(html), images: extractImageCandidates(feed || '') };
}
