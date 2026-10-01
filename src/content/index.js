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
    hosts: ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com'],
    match: isTwitterContentUrl,
    fetch: fetchTweetThread,
    options: ['thread'],
    limits: TWITTER_LIMITS,
  },
];

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
  return source.fetch(url, options);
}

/** A Thread, or its plain-text rendering when `format` is text. */
export function formatContent(result, format = 'json') {
  return format === 'text' ? toPlainText(result) : result;
}
