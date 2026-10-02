import { AppError } from '../utils/errors.js';
import { isRedditContentUrl, fetchRedditThread, REDDIT_LIMITS } from './reddit.js';
import { isTwitterContentUrl, fetchTweetThread, TWITTER_LIMITS } from './twitter.js';
import { isBlueskyContentUrl, fetchBlueskyThread, BLUESKY_LIMITS } from './bluesky.js';
import { isInstagramContentUrl, fetchInstagramThread, INSTAGRAM_LIMITS } from './instagram.js';
import { isTiktokContentUrl, fetchTiktokThread, TIKTOK_LIMITS } from './tiktok.js';
import { isBooruContentUrl, fetchBooruThread, BOORU_LIMITS } from './booru.js';
import { isPinterestContentUrl, fetchPinterestThread, PINTEREST_LIMITS } from './pinterest.js';
import { isVideoContentUrl, fetchVideoThread, VIDEO_LIMITS } from './video.js';
import { toPlainText } from './schema.js';

export { toPlainText } from './schema.js';

// Every source the content api can read, in the order a link is matched
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
  {
    id: 'bluesky',
    label: 'Bluesky',
    hosts: ['bsky.app'],
    match: isBlueskyContentUrl,
    fetch: fetchBlueskyThread,
    options: ['thread', 'comments'],
    limits: BLUESKY_LIMITS,
  },
  {
    id: 'instagram',
    label: 'Instagram',
    hosts: ['instagram.com'],
    match: isInstagramContentUrl,
    fetch: fetchInstagramThread,
    options: [],
    limits: INSTAGRAM_LIMITS,
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    hosts: ['tiktok.com'],
    match: isTiktokContentUrl,
    fetch: fetchTiktokThread,
    options: [],
    limits: TIKTOK_LIMITS,
  },
  {
    id: 'booru',
    label: 'Booru',
    hosts: [
      'danbooru.donmai.us',
      'e621.net',
      'e926.net',
      'yande.re',
      'konachan.com',
      'konachan.net',
    ],
    match: isBooruContentUrl,
    fetch: fetchBooruThread,
    options: [],
    limits: BOORU_LIMITS,
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    hosts: ['pinterest.com', 'pin.it'],
    match: isPinterestContentUrl,
    fetch: fetchPinterestThread,
    options: [],
    limits: PINTEREST_LIMITS,
  },
  // Last: any other site yt-dlp knows, read as video metadata.
  {
    id: 'video',
    label: 'Video sites',
    hosts: [
      'youtube.com',
      'youtu.be',
      'soundcloud.com',
      'twitch.tv',
      'vimeo.com',
      'dailymotion.com',
    ],
    match: isVideoContentUrl,
    fetch: fetchVideoThread,
    options: ['comments'],
    limits: VIDEO_LIMITS,
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

export function formatContent(result, format = 'json') {
  return format === 'text' ? toPlainText(result) : result;
}
