import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { NetworkError } from '../utils/errors.js';
import { canonicalizeMirrorUrl } from '../utils/cobalt.js';
import { post, thread, isoDate, linksIn } from './schema.js';

const logger = createLogger('content-twitter');

// FxTwitter's public json api: one tweet with its quote, media, poll and the id it replies to,
// no cookies needed. It does not return a conversation, so a thread is rebuilt by walking the
// reply chain upward while the author stays the same. Walking downward (the tweets after the
// linked one) needs x's own graphql TweetDetail with a session cookie; see wiki/Content-API.md.
const API_BASE = process.env.FXTWITTER_API_URL?.trim() || 'https://api.fxtwitter.com';
const API_TIMEOUT_MS = 15000;
const USER_AGENT = 'gronka (+https://web.gronka.dev)';

export const TWITTER_LIMITS = { thread: 25, budgetMs: 40000 };

const STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,20}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})(?:\/|$)/;

/** Whether a link points at one post on x, twitter, or an embed-fixer mirror of either. */
export function isTwitterContentUrl(url) {
  return tweetIdFromUrl(url) !== null;
}

export function tweetIdFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(canonicalizeMirrorUrl(url));
    const host = hostname.toLowerCase().replace(/^(?:www|mobile)\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    return STATUS_PATH.exec(pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function statusUrl(handle, id) {
  return `https://x.com/${handle ?? 'i'}/status/${id}`;
}

function mediaOf(media) {
  const out = [];
  for (const item of media?.all ?? []) {
    out.push({
      type: item.type === 'photo' ? 'image' : item.type === 'gif' ? 'gif' : 'video',
      url: item.url,
      alt: item.altText ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
    });
  }
  return out;
}

export function normalizeFxTweet(tweet, depth = 0) {
  const handle = tweet?.author?.screen_name ?? null;
  const text = tweet?.article?.content?.text ?? tweet?.text ?? '';
  // t.co wrappers say nothing, and the quoted post's own link is already `quoted`.
  const links = linksIn(text).filter(
    link => !/^https:\/\/t\.co\//.test(link) && tweetIdFromUrl(link) !== (tweet?.quote?.id ?? null)
  );
  if (tweet?.media?.external?.url) links.push(tweet.media.external.url);
  return post({
    id: tweet?.id ?? null,
    url: tweet?.url ?? (tweet?.id ? statusUrl(handle, tweet.id) : null),
    author: {
      handle,
      name: tweet?.author?.name ?? null,
      url: handle ? `https://x.com/${handle}` : null,
    },
    createdAt: isoDate(tweet?.created_timestamp),
    text,
    media: mediaOf(tweet?.media),
    links: [...new Set(links)],
    quoted: tweet?.quote && depth === 0 ? normalizeFxTweet(tweet.quote, 1) : null,
    parent: tweet?.replying_to_status
      ? {
          id: tweet.replying_to_status,
          url: statusUrl(tweet.replying_to ?? null, tweet.replying_to_status),
          author: tweet.replying_to
            ? { handle: tweet.replying_to, name: null, url: `https://x.com/${tweet.replying_to}` }
            : null,
        }
      : null,
    stats: {
      likes: tweet?.likes,
      reposts: tweet?.retweets,
      replies: tweet?.replies,
      views: tweet?.views,
    },
    flags: { nsfw: tweet?.possibly_sensitive },
    extra: {
      lang: tweet?.lang ?? null,
      source: tweet?.source ?? null,
      article: tweet?.article ? { title: tweet.article.title ?? null } : null,
      poll: tweet?.poll
        ? {
            options: tweet.poll.choices?.map(choice => ({
              text: choice.label,
              votes: choice.count ?? null,
            })),
            totalVotes: tweet.poll.total_votes ?? null,
            endsAt: tweet.poll.ends_at ?? null,
          }
        : null,
      communityNote: tweet?.community_note?.text ?? null,
    },
  });
}

async function fetchTweet(id, fetcher) {
  let response;
  try {
    response = await fetcher(`${API_BASE}/i/status/${id}`);
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      throw new NetworkError(
        'this post is unavailable, it may be deleted or private',
        'CONTENT_GONE'
      );
    }
    if (status === 401 || status === 403) {
      throw new NetworkError('this post is private or age restricted', 'CONTENT_GONE');
    }
    if (status === 429) {
      throw new NetworkError('x is rate limiting right now, try again shortly.');
    }
    logger.warn(`FxTwitter request failed: ${error.message}`);
    throw new NetworkError('failed to reach x');
  }
  const tweet = response?.tweet ?? response?.data?.tweet;
  if (!tweet || response?.code === 404 || response?.data?.code === 404) {
    throw new NetworkError(
      'this post is unavailable, it may be deleted or private',
      'CONTENT_GONE'
    );
  }
  return tweet;
}

async function defaultFetcher(url) {
  const response = await axios.get(url, {
    responseType: 'json',
    timeout: API_TIMEOUT_MS,
    maxRedirects: 2,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  return response.data;
}

/**
 * A Thread for one x post. `thread` walks the reply chain upward while the author matches, so a
 * link to the last post of a thread answers with the whole thread; a link to the first answers
 * with that post alone, because the api has no way down.
 */
export async function fetchTweetThread(
  url,
  { thread: walk = true, fetcher = defaultFetcher } = {}
) {
  const id = tweetIdFromUrl(url);
  if (!id) {
    throw new NetworkError('that is not a link to an x post', 'BAD_URL', 400);
  }
  const first = await fetchTweet(id, fetcher);
  const subject = normalizeFxTweet(first);
  const chain = [subject];
  let truncated = false;

  if (walk) {
    const started = Date.now();
    let current = first;
    while (current.replying_to_status && current.replying_to === current.author?.screen_name) {
      if (chain.length >= TWITTER_LIMITS.thread || Date.now() - started > TWITTER_LIMITS.budgetMs) {
        truncated = true;
        break;
      }
      let parent;
      try {
        parent = await fetchTweet(current.replying_to_status, fetcher);
      } catch (error) {
        // The chain above may be deleted or gone private; what was read is still a thread.
        logger.info(`Thread walk stopped at ${current.replying_to_status}: ${error.message}`);
        truncated = true;
        break;
      }
      chain.unshift(normalizeFxTweet(parent));
      current = parent;
    }
  }

  return thread({
    source: 'twitter',
    url: subject.url ?? statusUrl(subject.author.handle, id),
    post: subject,
    thread: chain.length > 1 ? chain : [],
    truncated,
  });
}
