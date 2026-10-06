import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { NetworkError, contentGone } from '../utils/errors.js';
import { post, comment, thread, MAX_COMMENTS } from './schema.js';

const logger = createLogger('content-bluesky');

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread';
const API_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const NSFW_LABELS = new Set(['porn', 'sexual', 'nudity']);

export const BLUESKY_LIMITS = { thread: 25, comments: MAX_COMMENTS, depth: 6 };

const POST_PATH = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)\/?$/;

function parseUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname.toLowerCase().replace(/^www\./, '') !== 'bsky.app') return null;
    const match = POST_PATH.exec(pathname);
    return match ? { actor: decodeURIComponent(match[1]), rkey: match[2] } : null;
  } catch {
    return null;
  }
}

export function isBlueskyContentUrl(url) {
  return parseUrl(url) !== null;
}

async function request(uri, { depth, parentHeight }) {
  try {
    const { data } = await axios.get(API, {
      params: { uri, depth, parentHeight },
      timeout: API_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    return data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 404) {
      const code = error.response?.data?.error;
      if (code === 'NotFound' || code === 'InvalidRequest') throw contentGone();
    }
    logger.warn(`Bluesky getPostThread failed: ${error.message}`);
    throw new NetworkError('failed to reach bluesky');
  }
}

const rkeyOf = uri =>
  String(uri ?? '')
    .split('/')
    .pop();
const didOf = uri => /^at:\/\/([^/]+)/.exec(uri ?? '')?.[1] ?? null;

const postUrl = (author, uri) =>
  `https://bsky.app/profile/${author?.handle ?? didOf(uri)}/post/${rkeyOf(uri)}`;

const authorOf = author => ({
  handle: author?.handle ?? null,
  name: author?.displayName || null,
  url: author?.handle ? `https://bsky.app/profile/${author.handle}` : null,
});

function mediaOf(embed) {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view':
      return embed.images.map(image => ({
        type: 'image',
        url: image.fullsize,
        alt: image.alt || null,
        width: image.aspectRatio?.width ?? null,
        height: image.aspectRatio?.height ?? null,
      }));
    case 'app.bsky.embed.video#view':
      return [
        {
          type: 'video',
          url: embed.playlist,
          alt: embed.alt || null,
          width: embed.aspectRatio?.width ?? null,
          height: embed.aspectRatio?.height ?? null,
        },
      ];
    case 'app.bsky.embed.recordWithMedia#view':
      return mediaOf(embed.media);
    default:
      return [];
  }
}

function externalOf(embed) {
  if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') return externalOf(embed.media);
  return embed?.$type === 'app.bsky.embed.external#view' ? (embed.external?.uri ?? null) : null;
}

// A quoted record is a viewRecord (value + embeds), reshaped here into a regular post view.
function quotedOf(embed, depth) {
  if (depth > 0) return null;
  const record =
    embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.record?.record : embed?.record;
  if (record?.$type !== 'app.bsky.embed.record#viewRecord') return null;
  return normalizePost({ ...record, record: record.value, embed: record.embeds?.[0] }, 1);
}

export function normalizePost(view, depth = 0) {
  if (!view?.uri || !view.record) return null;
  const { record, author } = view;
  const links = (record.facets ?? [])
    .flatMap(facet => facet.features ?? [])
    .filter(feature => feature.$type === 'app.bsky.richtext.facet#link')
    .map(feature => feature.uri);
  const external = externalOf(view.embed);
  const quoted = quotedOf(view.embed, depth);
  const reply = record.reply?.parent;
  return post({
    id: rkeyOf(view.uri),
    url: postUrl(author, view.uri),
    author: authorOf(author),
    createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : null,
    text: record.text ?? '',
    media: mediaOf(view.embed),
    links: [...new Set([...links, ...(external ? [external] : [])])],
    quoted,
    parent: reply
      ? {
          id: rkeyOf(reply.uri),
          url: `https://bsky.app/profile/${didOf(reply.uri)}/post/${rkeyOf(reply.uri)}`,
          author: null,
        }
      : null,
    stats: {
      likes: view.likeCount,
      reposts: view.repostCount,
      replies: view.replyCount,
    },
    flags: { nsfw: (view.labels ?? []).some(label => NSFW_LABELS.has(label.val)) },
    extra: { lang: record.langs?.[0] ?? null, quotes: view.quoteCount ?? null },
  });
}

const isPost = node => node?.$type === 'app.bsky.feed.defs#threadViewPost' && node.post;

function commentOf(node, depth) {
  const item = normalizePost(node.post);
  if (!item) return null;
  const replies =
    depth === 0
      ? (node.replies ?? [])
          .filter(isPost)
          .map(r => commentOf(r, 1))
          .filter(Boolean)
      : [];
  return comment({ ...item, depth, replies });
}

function ownChain(node, did) {
  const chain = [];
  let own = (node.replies ?? []).find(r => isPost(r) && r.post.author.did === did);
  while (own) {
    const item = normalizePost(own.post);
    if (item) chain.push(item);
    own = (own.replies ?? []).find(r => isPost(r) && r.post.author.did === did);
  }
  return chain;
}

export async function fetchBlueskyThread(
  url,
  { thread: walk = true, comments = 0, get = request } = {}
) {
  const parsed = parseUrl(url);
  if (!parsed) throw new NetworkError('that is not a link to a bluesky post', 'BAD_URL', 400);
  const want = Math.min(Math.max(Number(comments) || 0, 0), BLUESKY_LIMITS.comments);
  const data = await get(`at://${parsed.actor}/app.bsky.feed.post/${parsed.rkey}`, {
    depth: walk || want ? BLUESKY_LIMITS.depth : 0,
    parentHeight: walk ? BLUESKY_LIMITS.thread : 0,
  });
  const node = data?.thread;
  const subject = isPost(node) ? normalizePost(node.post) : null;
  if (!subject) throw contentGone();
  const did = node.post.author.did;

  const chain = [subject];
  let truncated = false;
  if (walk) {
    let above = node.parent;
    let top = node.post;
    while (isPost(above) && above.post.author.did === did) {
      const item = normalizePost(above.post);
      if (!item) break;
      chain.unshift(item);
      top = above.post;
      above = above.parent;
    }
    truncated = !isPost(above) && didOf(top.record?.reply?.parent?.uri) === did;
    chain.push(...ownChain(node, did));
  }

  let replies = [];
  if (want > 0) {
    const others = (node.replies ?? []).filter(r => isPost(r) && r.post.author.did !== did);
    replies = others
      .slice(0, want)
      .map(r => commentOf(r, 0))
      .filter(Boolean);
    truncated = truncated || others.length > want;
  }

  return thread({
    source: 'bluesky',
    url: subject.url,
    post: subject,
    thread: chain.length > 1 ? chain : [],
    comments: replies,
    truncated,
  });
}
