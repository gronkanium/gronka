import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { NetworkError, contentGone } from '../utils/errors.js';
import { canonicalizeMirrorUrl } from '../utils/cobalt.js';
import { readSessionCookie } from '../utils/session-cookie.js';
import { post, comment, thread, MAX_COMMENTS } from './schema.js';

const logger = createLogger('content-twitter');

// x's own web client api. Posts are read as a logged-out guest; the session cookie is used only
// for what guests cannot see (age-gated posts) and for replies, so the account stays quiet.
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const API_TIMEOUT_MS = 15000;
const GUEST_TTL_MS = 60 * 60 * 1000;

// Query ids change when x ships; these are refreshed from x.com's bundle when one stops working.
const queryIds = {
  TweetResultByRestId: 'LbQZrAWyKPvExi8di3-EoA',
  TweetDetail: 'blErEeZkos5TDrWmrCp7cw',
};
// Only the flags that change what comes back; x ignores unknown ones and needs none of them.
const FEATURES = Object.fromEntries(
  [
    'longform_notetweets_consumption_enabled',
    'longform_notetweets_rich_text_read_enabled',
    'longform_notetweets_inline_media_enabled',
    'responsive_web_twitter_article_tweet_consumption_enabled',
    'articles_preview_enabled',
    'view_counts_everywhere_api_enabled',
    'responsive_web_edit_tweet_api_enabled',
    'responsive_web_enhance_cards_enabled',
    'communities_web_enable_tweet_community_results_fetch',
    'creator_subscriptions_tweet_preview_api_enabled',
    'freedom_of_speech_not_reach_fetch_enabled',
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
    'standardized_nudges_misinfo',
  ].map(name => [name, true])
);
const FIELD_TOGGLES = { withArticlePlainText: true };

export const TWITTER_LIMITS = { thread: 25, comments: MAX_COMMENTS, pages: 1, budgetMs: 40000 };

const STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,20}|i(?:\/web)?)\/status(?:es)?\/(\d{1,25})(?:\/|$)/;

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

const statusUrl = (handle, id) => `https://x.com/${handle ?? 'i'}/status/${id}`;
const sessionCookie = () => readSessionCookie('twitter', 'auth_token=');

let guest = null;
async function guestToken(fresh = false) {
  if (!fresh && guest && guest.expires > Date.now()) return guest.token;
  const { data } = await axios.post('https://api.x.com/1.1/guest/activate.json', null, {
    timeout: API_TIMEOUT_MS,
    headers: { authorization: `Bearer ${BEARER}`, 'user-agent': USER_AGENT },
  });
  guest = { token: data.guest_token, expires: Date.now() + GUEST_TTL_MS };
  return guest.token;
}

// The logged-in web client's bundle lists every operation as queryId:"…",operationName:"…".
async function refreshQueryIds(cookie) {
  const page = await axios.get('https://x.com/home', {
    timeout: API_TIMEOUT_MS,
    headers: { cookie, 'user-agent': USER_AGENT },
  });
  const main = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']*?\/main\.\w+\.js/.exec(
    page.data
  )?.[0];
  if (!main) return false;
  const { data: js } = await axios.get(main, {
    timeout: API_TIMEOUT_MS,
    headers: { 'user-agent': USER_AGENT },
  });
  let found = false;
  for (const name of Object.keys(queryIds)) {
    const id = new RegExp(`queryId:"([\\w-]+)",operationName:"${name}"`).exec(js)?.[1];
    if (id) [queryIds[name], found] = [id, true];
  }
  return found;
}

async function request(op, variables, { session, retried = false }) {
  const cookie = session ? sessionCookie() : null;
  if (session && !cookie) {
    throw new NetworkError('x has no session to read this with', 'NO_SESSION');
  }
  const headers = { authorization: `Bearer ${BEARER}`, 'user-agent': USER_AGENT };
  if (cookie) {
    headers.cookie = cookie;
    headers['x-csrf-token'] = /(?:^|;\s*)ct0=([^;]+)/.exec(cookie)?.[1] ?? '';
    headers['x-twitter-auth-type'] = 'OAuth2Session';
  } else {
    headers['x-guest-token'] = await guestToken(retried);
  }
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
    fieldToggles: JSON.stringify(FIELD_TOGGLES),
  });
  const host = cookie ? 'https://x.com/i/api' : 'https://api.x.com';
  try {
    const { data } = await axios.get(`${host}/graphql/${queryIds[op]}/${op}?${params}`, {
      timeout: API_TIMEOUT_MS,
      headers,
    });
    return data;
  } catch (error) {
    const status = error.response?.status;
    if (!retried && (status === 401 || status === 403) && !cookie) {
      return request(op, variables, { session, retried: true });
    }
    if (!retried && (status === 400 || status === 404)) {
      const refreshed = await refreshQueryIds(cookie ?? sessionCookie() ?? '').catch(() => false);
      if (refreshed) return request(op, variables, { session, retried: true });
    }
    if (status === 429) {
      throw new NetworkError('x is rate limiting right now, try again shortly.');
    }
    if (session && (status === 401 || status === 403)) {
      logger.error(
        `X refused the session cookie (HTTP ${status}); the twitter entry needs a fresh login`
      );
    }
    logger.warn(`X ${op} request failed: ${error.message}`);
    throw new NetworkError('failed to reach x');
  }
}

const unwrap = result =>
  result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;

function bestVideo(media) {
  const mp4 = (media.video_info?.variants ?? []).filter(v => v.content_type === 'video/mp4');
  return mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? null;
}

function mediaOf(legacy) {
  return (legacy?.extended_entities?.media ?? []).map(item => ({
    type: item.type === 'photo' ? 'image' : item.type === 'animated_gif' ? 'gif' : 'video',
    url: item.type === 'photo' ? `${item.media_url_https}?name=orig` : bestVideo(item),
    alt: item.ext_alt_text ?? null,
    width: item.original_info?.width ?? null,
    height: item.original_info?.height ?? null,
  }));
}

function pollOf(card) {
  const values = Object.fromEntries(
    (card?.legacy?.binding_values ?? []).map(({ key, value }) => [key, value])
  );
  if (!values.choice1_label) return null;
  const options = [];
  for (let i = 1; values[`choice${i}_label`]; i++) {
    const count = values[`choice${i}_count`]?.string_value;
    options.push({
      text: values[`choice${i}_label`].string_value,
      votes: count === undefined ? null : Number(count),
    });
  }
  return { options, endsAt: values.end_datetime_utc?.string_value ?? null };
}

// The body as written: long-post text when present, t.co links expanded, the media link dropped.
function textOf(tweet) {
  const note = tweet.note_tweet?.note_tweet_results?.result;
  const legacy = tweet.legacy ?? {};
  let text = note?.text ?? legacy.full_text ?? '';
  const urls = note?.entity_set?.urls ?? legacy.entities?.urls ?? [];
  for (const { url, expanded_url: expanded } of urls) text = text.split(url).join(expanded);
  for (const { url } of legacy.entities?.media ?? []) text = text.split(url).join('');
  return { text: text.trim(), urls: urls.map(u => u.expanded_url).filter(Boolean) };
}

export function normalizeTweet(result, depth = 0) {
  const tweet = unwrap(result);
  if (!tweet?.legacy) return null;
  const { legacy } = tweet;
  const user = tweet.core?.user_results?.result;
  const handle = user?.core?.screen_name ?? user?.legacy?.screen_name ?? null;
  const { text, urls } = textOf(tweet);
  const article = tweet.article?.article_results?.result;
  const quoted = depth === 0 ? normalizeTweet(tweet.quoted_status_result?.result, 1) : null;
  const views = Number(tweet.views?.count);
  return post({
    id: tweet.rest_id ?? legacy.id_str ?? null,
    url: statusUrl(handle, tweet.rest_id ?? legacy.id_str),
    author: {
      handle,
      name: user?.core?.name ?? user?.legacy?.name ?? null,
      url: handle ? `https://x.com/${handle}` : null,
    },
    createdAt: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
    title: article?.title ?? null,
    text: article?.plain_text ?? text,
    media: mediaOf(legacy),
    links: [...new Set(urls.filter(link => !quoted || tweetIdFromUrl(link) !== quoted.id))],
    quoted,
    parent: legacy.in_reply_to_status_id_str
      ? {
          id: legacy.in_reply_to_status_id_str,
          url: statusUrl(legacy.in_reply_to_screen_name, legacy.in_reply_to_status_id_str),
          author: legacy.in_reply_to_screen_name
            ? {
                handle: legacy.in_reply_to_screen_name,
                name: null,
                url: `https://x.com/${legacy.in_reply_to_screen_name}`,
              }
            : null,
        }
      : null,
    stats: {
      likes: legacy.favorite_count,
      reposts: legacy.retweet_count,
      replies: legacy.reply_count,
      views: Number.isFinite(views) ? views : null,
    },
    flags: {
      nsfw: legacy.possibly_sensitive,
      edited: (tweet.edit_control?.edit_tweet_ids?.length ?? 1) > 1,
    },
    extra: {
      lang: legacy.lang ?? null,
      quotes: legacy.quote_count ?? null,
      poll: pollOf(tweet.card),
      communityNote: tweet.birdwatch_pivot?.subtitle?.text ?? null,
    },
  });
}

// One post: as a guest first, then with the session when x hides it from guests.
async function readTweet(id, gql) {
  const variables = {
    tweetId: id,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  };
  const asGuest = await gql('TweetResultByRestId', variables, { session: false });
  let result = asGuest?.data?.tweetResult?.result;
  if (!unwrap(result)?.legacy && sessionCookie()) {
    const asUser = await gql('TweetResultByRestId', variables, { session: true });
    result = asUser?.data?.tweetResult?.result;
  }
  if (!unwrap(result)?.legacy) throw contentGone();
  return unwrap(result);
}

const tweetsIn = entry => {
  const content = entry.content ?? {};
  const items = content.items ?? (content.itemContent ? [{ item: content }] : []);
  return items
    .map(({ item }) => item?.itemContent?.tweet_results?.result)
    .filter(result => unwrap(result)?.legacy);
};

const cursorIn = entries =>
  entries
    .map(e => e.content?.itemContent ?? e.content)
    .find(
      c =>
        c?.cursorType === 'Bottom' ||
        c?.cursorType === 'ShowMoreThreads' ||
        c?.cursorType === 'ShowMore'
    )?.value ?? null;

// Replies from the logged-in conversation view. The author's own continuation of the post comes
// back as the first module; it is the rest of the thread, not a comment.
async function readConversation(id, author, want, gql) {
  const comments = [];
  const continuation = [];
  let cursor = null;
  let truncated = false;
  for (let page = 0; page < TWITTER_LIMITS.pages; page++) {
    const data = await gql(
      'TweetDetail',
      {
        focalTweetId: id,
        ...(cursor ? { cursor, referrer: 'tweet' } : {}),
        with_rux_injections: false,
        rankingMode: 'Relevance',
        includePromotedContent: false,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: false,
        withBirdwatchNotes: true,
        withVoice: true,
      },
      { session: true }
    );
    const entries =
      data?.data?.threaded_conversation_with_injections_v2?.instructions?.flatMap(
        i => i.entries ?? []
      ) ?? [];
    for (const entry of entries) {
      if (!entry.entryId?.startsWith('conversationthread-')) continue;
      const [first, ...rest] = tweetsIn(entry).map(r => normalizeTweet(r));
      if (!first) continue;
      const selfThread =
        page === 0 &&
        !comments.length &&
        !continuation.length &&
        first.author.handle === author &&
        first.parent?.id === id;
      if (selfThread) {
        continuation.push(first, ...rest.filter(t => t.author.handle === author));
        continue;
      }
      if (comments.length >= want) {
        truncated = true;
        break;
      }
      comments.push(
        comment({ ...first, depth: 0, replies: rest.map(r => comment({ ...r, depth: 1 })) })
      );
    }
    cursor = cursorIn(entries);
    if (!cursor || comments.length >= want) {
      truncated = truncated || Boolean(cursor);
      break;
    }
    if (page === TWITTER_LIMITS.pages - 1) truncated = true;
  }
  return { comments, continuation, truncated };
}

export async function fetchTweetThread(
  url,
  { thread: walk = true, comments = 0, gql = request } = {}
) {
  const id = tweetIdFromUrl(url);
  if (!id) {
    throw new NetworkError('that is not a link to an x post', 'BAD_URL', 400);
  }
  const subject = normalizeTweet(await readTweet(id, gql));
  const chain = [subject];
  let truncated = false;

  if (walk) {
    const started = Date.now();
    let current = subject;
    while (current.parent && current.parent.author?.handle === subject.author.handle) {
      if (chain.length >= TWITTER_LIMITS.thread || Date.now() - started > TWITTER_LIMITS.budgetMs) {
        truncated = true;
        break;
      }
      try {
        current = normalizeTweet(await readTweet(current.parent.id, gql));
      } catch (error) {
        logger.debug(`Thread walk stopped at ${current.parent.id}: ${error.message}`);
        truncated = true;
        break;
      }
      chain.unshift(current);
    }
  }

  let replies = [];
  const want = Math.min(comments, TWITTER_LIMITS.comments);
  if (want > 0) {
    if (sessionCookie()) {
      const conversation = await readConversation(id, subject.author.handle, want, gql);
      replies = conversation.comments;
      if (walk) chain.push(...conversation.continuation);
      truncated = truncated || conversation.truncated;
    } else {
      truncated = true;
    }
  }

  return thread({
    source: 'twitter',
    url: subject.url,
    post: subject,
    thread: chain.length > 1 ? chain : [],
    comments: replies,
    truncated,
  });
}
