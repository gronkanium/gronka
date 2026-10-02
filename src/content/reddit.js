import { createLogger } from '../utils/logger.js';
import { NetworkError } from '../utils/errors.js';
import { fetchRedditListing, isRedditPostUrl, commentIdFromUrl } from '../utils/reddit.js';
import { post, comment, thread, isoDate, linksIn, MAX_COMMENTS } from './schema.js';

const logger = createLogger('content-reddit');

export const REDDIT_LIMITS = { depth: 10, comments: MAX_COMMENTS, listing: 100 };

export const isRedditContentUrl = isRedditPostUrl;

function authorOf(data) {
  const handle = data?.author && data.author !== '[deleted]' ? data.author : null;
  return { handle, name: handle, url: handle ? `https://www.reddit.com/user/${handle}` : null };
}

function mediaOf(data) {
  const out = [];
  const video = data?.media?.reddit_video ?? data?.secure_media?.reddit_video;
  if (video?.fallback_url) {
    out.push({
      type: video.is_gif ? 'gif' : 'video',
      url: video.fallback_url,
      alt: null,
      width: video.width ?? null,
      height: video.height ?? null,
    });
  }
  const order =
    data?.gallery_data?.items?.map(item => item.media_id) ??
    Object.keys(data?.media_metadata ?? {});
  for (const id of order) {
    const entry = data?.media_metadata?.[id];
    if (entry?.status !== 'valid') continue;
    const animated = entry.e === 'AnimatedImage';
    const url = animated ? entry.s?.gif || entry.s?.mp4 : entry.s?.u;
    if (!url) continue;
    out.push({
      type: animated ? 'gif' : 'image',
      url,
      alt: data?.media_metadata?.[id]?.caption ?? null,
      width: entry.s?.x ?? null,
      height: entry.s?.y ?? null,
    });
  }
  const target = data?.url_overridden_by_dest || data?.url;
  if (out.length === 0 && typeof target === 'string' && /^https:\/\/i\.redd\.it\//.test(target)) {
    out.push({
      type: /\.gif$/i.test(target) ? 'gif' : 'image',
      url: target,
      alt: null,
      width: null,
      height: null,
    });
  }
  return out;
}

function linksOf(data) {
  const links = new Set(linksIn(data?.selftext));
  const target = data?.url_overridden_by_dest || data?.url;
  // A link post's target is the point of the post; its own permalink is not a link.
  if (
    typeof target === 'string' &&
    !data?.is_self &&
    !/^https:\/\/(?:i|v)\.redd\.it\//.test(target)
  ) {
    links.add(target);
  }
  return [...links];
}

function permalink(data) {
  return data?.permalink ? `https://www.reddit.com${data.permalink}` : null;
}

export function normalizeRedditPost(data, depth = 0) {
  const crosspost = data?.crosspost_parent_list?.[0];
  return post({
    id: data?.id ?? null,
    url: permalink(data),
    author: authorOf(data),
    createdAt: isoDate(data?.created_utc),
    title: data?.title ?? null,
    text: data?.selftext ?? '',
    media: mediaOf(data),
    links: linksOf(data),
    quoted: crosspost && depth === 0 ? normalizeRedditPost(crosspost, 1) : null,
    stats: {
      score: data?.score,
      likes: data?.ups,
      replies: data?.num_comments,
    },
    flags: {
      nsfw: data?.over_18,
      spoiler: data?.spoiler,
      edited: typeof data?.edited === 'number',
    },
    extra: {
      subreddit: data?.subreddit ?? null,
      flair: data?.link_flair_text ?? null,
      upvoteRatio: data?.upvote_ratio ?? null,
      removed: data?.removed_by_category ?? null,
      poll: data?.poll_data
        ? {
            options: data.poll_data.options?.map(option => ({
              text: option.text,
              votes: option.vote_count ?? null,
            })),
            totalVotes: data.poll_data.total_vote_count ?? null,
          }
        : null,
    },
  });
}

function normalizeComment(data, depth, budget, state) {
  const replies = [];
  const children = data?.replies?.data?.children ?? [];
  for (const child of children) {
    if (child.kind !== 't1') {
      // A `more` stub stands in for replies reddit did not send; fetching them is another call.
      if (child.kind === 'more' && child.data?.count > 0) state.truncated = true;
      continue;
    }
    if (depth + 1 >= budget.depth || state.count >= budget.comments) {
      state.truncated = true;
      break;
    }
    state.count += 1;
    replies.push(normalizeComment(child.data, depth + 1, budget, state));
  }
  return comment({
    id: data?.id ?? null,
    url: permalink(data),
    author: authorOf(data),
    createdAt: isoDate(data?.created_utc),
    text: data?.body ?? '',
    media: mediaOf(data),
    links: linksIn(data?.body),
    parent: data?.parent_id
      ? { id: data.parent_id.replace(/^t[13]_/, ''), url: null, author: null }
      : null,
    stats: { score: data?.score, likes: data?.ups },
    flags: { edited: typeof data?.edited === 'number' },
    extra: {
      op: Boolean(data?.is_submitter),
      distinguished: data?.distinguished ?? null,
      stickied: Boolean(data?.stickied),
      awards: data?.total_awards_received ?? 0,
    },
    depth,
    replies,
  });
}

// A Thread from reddit's own .json listing: the post, then the comment tree capped by depth and total count
export function normalizeRedditListing(listing, url, { depth, comments } = {}) {
  const data = listing?.[0]?.data?.children?.[0]?.data;
  if (!data) {
    throw new NetworkError(
      'this post is unavailable, it may be deleted or private',
      'CONTENT_GONE'
    );
  }
  const budget = {
    depth: Math.min(Math.max(depth ?? REDDIT_LIMITS.depth, 0), REDDIT_LIMITS.depth),
    comments: Math.min(Math.max(comments ?? 0, 0), REDDIT_LIMITS.comments),
  };
  const state = { count: 0, truncated: false };
  const roots = listing?.[1]?.data?.children ?? [];
  const commentId = commentIdFromUrl(url);
  const focus = commentId
    ? roots.find(child => child.kind === 't1' && child.data?.id === commentId)
    : null;

  const tree = [];
  if (focus) {
    // The focused comment is the subject; its children become the top of the tree.
    const asComment = normalizeComment(
      focus.data,
      0,
      { ...budget, depth: budget.depth + 1 },
      state
    );
    const { depth: _depth, replies, ...rest } = asComment;
    const subject = post({ ...rest, title: null });
    return thread({
      source: 'reddit',
      url,
      post: subject,
      comments: replies,
      truncated: state.truncated,
    });
  }

  for (const child of roots) {
    if (child.kind !== 't1') {
      if (child.kind === 'more' && child.data?.count > 0) state.truncated = true;
      continue;
    }
    if (state.count >= budget.comments || budget.depth === 0) {
      state.truncated = true;
      break;
    }
    state.count += 1;
    tree.push(normalizeComment(child.data, 0, budget, state));
  }
  if (commentId)
    logger.info(`Reddit comment ${commentId} not in the listing, answering with the post`);
  return thread({
    source: 'reddit',
    url,
    post: normalizeRedditPost(data),
    comments: tree,
    truncated: state.truncated,
  });
}

export async function fetchRedditThread(url, options = {}) {
  const { url: canonical, listing } = await fetchRedditListing(url, {
    limit: Math.min(options.comments ?? REDDIT_LIMITS.listing, REDDIT_LIMITS.listing),
  });
  return normalizeRedditListing(listing, canonical, options);
}
