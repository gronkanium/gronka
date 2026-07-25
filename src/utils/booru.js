import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('booru');

// Booru image boards expose a clean per-post JSON API returning the direct file URL, so
// no HTML scraping is needed. Two caveats drive the custom User-Agent: e621 asks clients
// not to impersonate a browser, and danbooru's API *and* CDN 403 the shared Chrome UA
// from getRequestHeaders() while accepting a descriptive one. So both the API fetch and
// the media download (via downloadFileFromUrl's userAgent override) use BOORU_UA.
const BOORU_UA = 'gronka (+https://github.com/thedorekaczynski/gronka)';
const API_TIMEOUT_MS = 20000;

// Danbooru-style boards expose the post directly at /posts/<id>.json.
const postJsonApiUrl = (host, postId) => `https://${host}/posts/${postId}.json`;

// Moebooru boards (yande.re, konachan) have no per-post endpoint — the index is queried by
// id tag and answers with a one-element array, or an empty one when the post is gone.
const moebooruApiUrl = (host, postId) => `https://${host}/post.json?tags=id:${postId}`;
const moebooruFileUrl = json => (Array.isArray(json) ? (json[0]?.file_url ?? null) : null);

const BOORU_SITES = [
  {
    name: 'danbooru',
    hosts: ['danbooru.donmai.us'],
    buildApiUrl: postJsonApiUrl,
    // { ..., file_url: "https://cdn.donmai.us/original/.../<md5>.<ext>" }
    pickFileUrl: json => json.file_url || null,
  },
  {
    name: 'e621',
    hosts: ['e621.net', 'e926.net'],
    buildApiUrl: postJsonApiUrl,
    // { post: { file: { url: "https://static1.e621.net/data/.../<md5>.<ext>" } } }
    pickFileUrl: json => json.post?.file?.url || null,
  },
  {
    name: 'yande.re',
    hosts: ['yande.re'],
    buildApiUrl: moebooruApiUrl,
    // [ { ..., file_url: "https://files.yande.re/image/<md5>/yande.re%20<id>%20<tags>.<ext>" } ]
    pickFileUrl: moebooruFileUrl,
  },
  {
    name: 'konachan',
    hosts: ['konachan.com', 'konachan.net'],
    buildApiUrl: moebooruApiUrl,
    // [ { ..., file_url: "https://konachan.com/image/<md5>/Konachan.com%20-%20<id>%20<tags>.<ext>" } ]
    pickFileUrl: moebooruFileUrl,
  },
];

/** Match a hostname (www-stripped) to a booru site definition, or null. */
function matchSite(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return BOORU_SITES.find(site => site.hosts.includes(host)) || null;
}

/**
 * Extract a numeric post id from a booru post path.
 * Handles /posts/<id> (danbooru, e621) and /post/show/<id> (yande.re, konachan, and
 * legacy e621).
 * @param {string} pathname - URL pathname
 * @returns {string|null} The post id, or null if the path is not a post page
 */
function parsePostId(pathname) {
  const match = pathname.match(/\/post(?:s|\/show)\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Check whether a URL is a supported booru post page.
 * @param {string} url - URL to check
 * @returns {boolean} True if the URL is a post page on a supported board
 *   (danbooru, e621/e926, yande.re, konachan)
 */
export function isBooruUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return matchSite(hostname) !== null && parsePostId(pathname) !== null;
  } catch {
    return false;
  }
}

/**
 * Download the media for a booru post URL.
 * Fetches the post's JSON API with a descriptive User-Agent, reads the direct file URL,
 * and downloads it via the shared file-downloader (reusing SSRF validation, size limits,
 * and content-type/filename detection), passing the same UA through so the CDN does not
 * 403. Returns the same { buffer, contentType, size, filename } shape as the other paths.
 * @param {string} url - Booru post URL
 * @param {boolean} isAdminUser - Admin users bypass size limits
 * @returns {Promise<{buffer: Buffer, contentType: string, size: number, filename: string}>}
 */
export async function downloadFromBooru(url, isAdminUser = false) {
  const { hostname, pathname } = new URL(url);
  const site = matchSite(hostname);
  const postId = parsePostId(pathname);
  if (!site || !postId) {
    throw new ValidationError('unsupported or malformed booru URL');
  }

  const host = hostname.toLowerCase().replace(/^www\./, '');
  const apiUrl = site.buildApiUrl(host, postId);
  logger.info(`Resolving ${site.name} post ${postId}: ${apiUrl}`);

  let data;
  try {
    const response = await axios.get(apiUrl, {
      ...ssrfGuardedRequest(),
      responseType: 'json',
      timeout: API_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': BOORU_UA, Accept: 'application/json' },
      validateStatus: status => status >= 200 && status < 400,
    });
    data = response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new NetworkError('this post is unavailable or has been deleted');
    }
    logger.warn(`Failed to fetch ${site.name} post ${postId}: ${error.message}`);
    throw new NetworkError('failed to fetch the post');
  }

  const fileUrl = site.pickFileUrl(data);
  if (!fileUrl) {
    // danbooru omits file_url for restricted/banned posts, e621 for deleted ones, and
    // Moebooru answers with an empty array when the id does not exist.
    logger.warn(`No media URL on ${site.name} post ${postId}`);
    throw new ValidationError('no downloadable media found for this post (it may be restricted)');
  }

  logger.info(`Extracted ${site.name} media URL: ${fileUrl}`);
  const result = await downloadFileFromUrl(fileUrl, isAdminUser, null, { userAgent: BOORU_UA });
  logger.info(
    `Downloaded ${site.name} media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
