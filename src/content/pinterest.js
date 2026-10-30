import { NetworkError, contentGone } from '../utils/errors.js';
import { isPinterestUrl, extractMediaUrl, fetchPinPage } from '../utils/pinterest.js';
import { post, thread, linksIn } from './schema.js';

export const PINTEREST_LIMITS = {};

export const isPinterestContentUrl = isPinterestUrl;

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
  if (!main || !media) {
    throw contentGone(`pinterest: pin page had no ${main ? 'media url' : 'post data'}`);
  }
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

export async function fetchPinterestThread(url, { fetchPage = fetchPinPage } = {}) {
  if (!isPinterestUrl(url)) {
    throw new NetworkError('that is not a link to a pinterest pin', 'BAD_URL', 400);
  }
  const page = await fetchPage(url);
  if (page.url.includes('show_error=true')) {
    throw contentGone(`pinterest: redirected to ${page.url.split('?')[0]} with show_error`);
  }
  const subject = normalizePinterestPin(String(page.html ?? ''), page.url);
  return thread({ source: 'pinterest', url: subject.url, post: subject });
}
