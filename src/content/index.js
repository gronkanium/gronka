import { AppError } from '../utils/errors.js';
import { isRedditContentUrl, fetchRedditThread, REDDIT_LIMITS } from './reddit.js';
import { isTwitterContentUrl, fetchTweetThread, TWITTER_LIMITS } from './twitter.js';
import { toPlainText } from './schema.js';

export { toPlainText } from './schema.js';

/**
 * Every source the content api can read, in the order a link is matched. `match` decides on
 * the link alone, `fetch` returns a Thread (src/content/schema.js). Add a source by adding a row.
 */
export const CONTENT_SOURCES = [
  {
    id: 'reddit',
    label: 'Reddit',
    hosts: ['reddit.com', 'redd.it'],
    match: isRedditContentUrl,
    fetch: fetchRedditThread,
    options: ['depth', 'comments'],
    limits: REDDIT_LIMITS,
  },
  {
    id: 'twitter',
    label: 'X / Twitter',
    hosts: ['x.com', 'twitter.com'],
    match: isTwitterContentUrl,
    fetch: fetchTweetThread,
    options: ['thread', 'comments'],
    limits: TWITTER_LIMITS,
  },
];

// The same link asked for again within a minute is answered from memory: posts barely change in
// that time, and it keeps a popular link from spending the x session's quota.
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 500;
const recent = new Map();

export function getContentSourceForUrl(url) {
  return CONTENT_SOURCES.find(source => source.match(url)) ?? null;
}

/**
 * Read the text content behind a link into a Thread. Options that a source does not take are
 * ignored, so a caller can always send the same body.
 * @param {string} url
 * @param {{ depth?: number, comments?: number, thread?: boolean }} options
 */
export async function fetchContent(url, options = {}) {
  const source = getContentSourceForUrl(url);
  if (!source) {
    throw new AppError(
      `content is only available for ${CONTENT_SOURCES.map(s => s.label.toLowerCase()).join(' and ')} posts.`,
      'UNSUPPORTED_SOURCE',
      400
    );
  }
  const key = JSON.stringify([
    url,
    options.thread !== false,
    options.depth ?? null,
    options.comments ?? 0,
  ]);
  const hit = recent.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await source.fetch(url, options);
  if (recent.size >= CACHE_ENTRIES) recent.delete(recent.keys().next().value);
  recent.set(key, { value, expires: Date.now() + CACHE_MS });
  return value;
}

/** A Thread, or its plain-text rendering when `format` is text. */
export function formatContent(result, format = 'json') {
  return format === 'text' ? toPlainText(result) : result;
}
