import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { selectMediaUrl } from './instagram.js';
import { ssrfGuardedRequest, PAGE_FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from './ssrf-guard.js';
import { normalizeHost } from './url-host.js';

const logger = createLogger('threads');

// Without browser navigation headers threads.com answers with an empty app shell, not the post.
const NAVIGATION_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const THREADS_HOSTS = new Set(['threads.com', 'threads.net']);
const POST_PATH = /^\/@[\w.]+\/post\/([A-Za-z0-9_-]+)/;

export function threadsPostCode(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return THREADS_HOSTS.has(normalizeHost(hostname))
      ? (pathname.match(POST_PATH)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

export const isThreadsUrl = url => threadsPostCode(url) !== null;

function findPost(value, code) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const post = findPost(item, code);
      if (post) return post;
    }
  } else if (value && typeof value === 'object') {
    if (value.code === code && 'media_type' in value) return value;
    for (const item of Object.values(value)) {
      const post = findPost(item, code);
      if (post) return post;
    }
  }
  return null;
}

// Every slide of the post, in order; null when the page does not carry that post at all.
export function extractThreadsMedia(html, code) {
  for (const match of html.matchAll(
    /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g
  )) {
    if (!match[1].includes(`"code":"${code}"`)) continue;
    let post;
    try {
      post = findPost(JSON.parse(match[1]), code);
    } catch {
      continue;
    }
    if (!post) continue;
    const items = post.carousel_media?.length ? post.carousel_media : [post];
    return items.map(item => selectMediaUrl(item)).filter(Boolean);
  }
  return null;
}

export async function downloadFromThreads(url) {
  const code = threadsPostCode(url);
  let response;
  try {
    response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      maxRedirects: 5,
      headers: NAVIGATION_HEADERS,
    });
  } catch (error) {
    if (error.response?.status === 404) {
      throw Object.assign(new NetworkError('this post is unavailable or has been deleted'), {
        code: 'CONTENT_GONE',
      });
    }
    throw new NetworkError(`failed to fetch the threads post (${error.message})`);
  }

  const mediaUrls = extractThreadsMedia(response.data, code);
  if (mediaUrls === null) {
    throw new NetworkError('threads did not return this post, it may be deleted or private');
  }
  if (mediaUrls.length === 0) {
    throw new ValidationError('this threads post has no photo or video to download');
  }
  logger.debug(`Threads post ${code}: ${mediaUrls.length} media item(s)`);
  const files = await Promise.all(mediaUrls.map(mediaUrl => downloadFileFromUrl(mediaUrl)));
  return files.length === 1 ? files[0] : files;
}
