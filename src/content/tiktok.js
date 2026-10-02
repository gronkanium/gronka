import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { NetworkError } from '../utils/errors.js';
import { normalizeHost } from '../utils/url-host.js';
import { post, thread, isoDate, linksIn } from './schema.js';

const logger = createLogger('content-tiktok');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export const TIKTOK_LIMITS = { thread: 0, comments: 0, pages: 1, budgetMs: 30000 };

const VIDEO_PATH = /^\/@([\w.-]+)\/(video|photo)\/(\d{5,25})(?:\/|$)/;
const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

const isTiktokHost = host => host === 'tiktok.com' || host.endsWith('.tiktok.com');

function parse(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return { host: normalizeHost(hostname), pathname };
  } catch {
    return null;
  }
}

export function isTiktokContentUrl(url) {
  const parsed = parse(url);
  if (!parsed || !isTiktokHost(parsed.host)) return false;
  if (SHORT_HOSTS.has(parsed.host)) return parsed.pathname.length > 1;
  return VIDEO_PATH.test(parsed.pathname) || /^\/t\/[\w-]+/.test(parsed.pathname);
}

const GONE = () =>
  new NetworkError('this post is unavailable, it may be deleted or private', 'CONTENT_GONE');

const keepOnTiktok = options => {
  if (!isTiktokHost(options.hostname ?? '')) throw new Error('redirect left tiktok');
};

// Short links redirect to the canonical page, so the page fetch doubles as the redirect follow.
const defaultHttp = {
  async page(url) {
    const response = await axios.get(url, {
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      maxRedirects: 5,
      beforeRedirect: keepOnTiktok,
      responseType: 'text',
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
    });
    return { html: response.data, url: response.request?.res?.responseUrl ?? url };
  },
  async oembed(url) {
    const { data } = await axios.get('https://www.tiktok.com/oembed', {
      params: { url },
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      headers: { 'user-agent': USER_AGENT },
    });
    return data;
  },
};

function itemStructOf(html) {
  const raw = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(
    html ?? ''
  )?.[1];
  if (!raw) return { item: null, gone: false };
  try {
    const detail = JSON.parse(raw).__DEFAULT_SCOPE__?.['webapp.video-detail'];
    const code = detail?.statusCode;
    return { item: detail?.itemInfo?.itemStruct ?? null, gone: Boolean(code) && code !== 0 };
  } catch {
    return { item: null, gone: false };
  }
}

function mediaOf(item) {
  const images = item.imagePost?.images;
  if (images?.length) {
    return images
      .map(image => ({
        type: 'image',
        url: image.imageURL?.urlList?.[0] ?? null,
        alt: null,
        width: image.imageWidth ?? null,
        height: image.imageHeight ?? null,
      }))
      .filter(entry => entry.url);
  }
  const { video } = item;
  if (!video) return [];
  const media = [];
  const cover = video.originCover || video.cover;
  if (cover) {
    media.push({
      type: 'image',
      url: cover,
      alt: null,
      width: video.width ?? null,
      height: video.height ?? null,
    });
  }
  const play = video.playAddr || video.downloadAddr;
  if (play) {
    media.push({
      type: 'video',
      url: play,
      alt: null,
      width: video.width ?? null,
      height: video.height ?? null,
    });
  }
  return media;
}

export function normalizeTiktokItem(item, url) {
  const handle = item.author?.uniqueId ?? null;
  const text = item.desc ?? '';
  return post({
    id: item.id ?? null,
    url,
    author: {
      handle,
      name: item.author?.nickname ?? null,
      url: handle ? `https://www.tiktok.com/@${handle}` : null,
    },
    createdAt: isoDate(Number(item.createTime)),
    text,
    media: mediaOf(item),
    links: linksIn(text),
    stats: {
      likes: item.stats?.diggCount,
      reposts: item.stats?.shareCount,
      replies: item.stats?.commentCount,
      views: item.stats?.playCount,
    },
    extra: {
      kind: item.imagePost ? 'photo' : 'video',
      music: item.music
        ? { title: item.music.title ?? null, author: item.music.authorName ?? null }
        : null,
    },
  });
}

export async function fetchTiktokThread(url, { http = defaultHttp } = {}) {
  if (!isTiktokContentUrl(url)) {
    throw new NetworkError('that is not a link to a tiktok post', 'BAD_URL', 400);
  }
  let page;
  try {
    page = await http.page(url);
  } catch (error) {
    if (error.response?.status === 404) throw GONE();
    logger.warn(`TikTok page request failed: ${error.message}`);
    throw new NetworkError('failed to reach tiktok');
  }
  const final = parse(page.url);
  const match = final && VIDEO_PATH.exec(final.pathname);
  if (!match) {
    throw new NetworkError('that is not a link to a tiktok post', 'BAD_URL', 400);
  }
  const canonical = `https://www.tiktok.com/@${match[1]}/${match[2]}/${match[3]}`;

  const { item, gone } = itemStructOf(page.html);
  if (item) {
    const subject = normalizeTiktokItem(item, canonical);
    return thread({ source: 'tiktok', url: canonical, post: subject });
  }
  if (gone) throw GONE();

  let oembed;
  try {
    oembed = await http.oembed(canonical);
  } catch (error) {
    if (error.response && error.response.status < 500) throw GONE();
    logger.warn(`TikTok oembed request failed: ${error.message}`);
    throw new NetworkError('failed to reach tiktok');
  }
  const handle = oembed?.author_unique_id ?? match[1];
  const subject = post({
    id: match[3],
    url: canonical,
    author: {
      handle,
      name: oembed?.author_name ?? null,
      url: `https://www.tiktok.com/@${handle}`,
    },
    text: oembed?.title ?? '',
    media: oembed?.thumbnail_url
      ? [
          {
            type: 'image',
            url: oembed.thumbnail_url,
            alt: null,
            width: oembed.thumbnail_width ?? null,
            height: oembed.thumbnail_height ?? null,
          },
        ]
      : [],
    links: linksIn(oembed?.title),
    extra: { kind: match[2] },
  });
  return thread({ source: 'tiktok', url: canonical, post: subject });
}
