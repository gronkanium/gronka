import axios from 'axios';
import { createLogger } from '../utils/logger.js';
import { NetworkError } from '../utils/errors.js';
import { getRequestHeaders } from '../utils/discord-cdn.js';
import { ssrfGuardedRequest, PAGE_FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from '../utils/ssrf-guard.js';
import { isPinterestUrl, extractMediaUrl } from '../utils/pinterest.js';
import { post, thread, linksIn } from './schema.js';

const logger = createLogger('content-pinterest');

export const PINTEREST_LIMITS = {};

export const isPinterestContentUrl = isPinterestUrl;

const GONE = () =>
  new NetworkError('this post is unavailable, it may be deleted or private', 'CONTENT_GONE');

async function request(url) {
  const response = await axios.get(url, {
    ...ssrfGuardedRequest(),
    responseType: 'text',
    timeout: PAGE_FETCH_TIMEOUT_MS,
    maxContentLength: MAX_PAGE_BYTES,
    maxRedirects: 5,
    headers: getRequestHeaders(),
    validateStatus: status => status >= 200 && status < 400,
  });
  return { html: response.data, url: response.request?.res?.responseUrl || url };
}

function jsonLd(html) {
  const found = {};
  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.['@type']) found[data['@type']] ??= data;
    } catch {
      continue;
    }
  }
  return found;
}

const counter = (data, type) =>
  data?.interactionStatistic?.find(item => item.interactionType?.['@type']?.endsWith(`/${type}`))
    ?.userInteractionCount;

const pixels = value => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

export function normalizePinterestPin(html, finalUrl) {
  const media = extractMediaUrl(html);
  const { SocialMediaPosting: posting, VideoObject: video } = jsonLd(html);
  const main = posting ?? video;
  if (!main || !media) throw GONE();
  const isVideo = media === video?.contentUrl;
  const pinner = posting?.author;
  const text = posting?.articleBody ?? video?.description ?? '';
  const url = posting?.sharedContent?.url ?? finalUrl;
  return post({
    id: /\/pin\/(\d+)/.exec(url)?.[1] ?? null,
    url,
    author: pinner
      ? {
          handle: pinner.alternateName ?? null,
          name: pinner.name ?? null,
          url: pinner.url ?? null,
        }
      : undefined,
    createdAt: posting?.datePublished ?? video?.uploadDate ?? null,
    title: posting?.headline ?? video?.name ?? null,
    text,
    media: [
      {
        type: isVideo ? 'video' : 'image',
        url: media,
        alt: null,
        width: isVideo ? pixels(video.width) : null,
        height: isVideo ? pixels(video.height) : null,
      },
    ],
    links: linksIn(text),
    stats: {
      likes: counter(posting, 'LikeAction') ?? counter(video, 'LikeAction'),
      replies: video?.commentCount,
      views: counter(video, 'WatchAction'),
    },
  });
}

export async function fetchPinterestThread(url, { fetchPage = request } = {}) {
  if (!isPinterestUrl(url)) {
    throw new NetworkError('that is not a link to a pinterest pin', 'BAD_URL', 400);
  }
  let page;
  try {
    page = await fetchPage(url);
  } catch (error) {
    if ([404, 410].includes(error.response?.status)) throw GONE();
    logger.warn(`Failed to fetch Pinterest pin page: ${error.message}`);
    throw new NetworkError('failed to fetch the pin page');
  }
  if (page.url.includes('show_error=true')) throw GONE();
  const subject = normalizePinterestPin(String(page.html ?? ''), page.url);
  return thread({ source: 'pinterest', url: subject.url, post: subject });
}
