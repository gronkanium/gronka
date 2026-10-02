import { createLogger } from '../utils/logger.js';
import { NetworkError } from '../utils/errors.js';
import {
  isInstagramPostUrl,
  shortcodeToMediaId,
  instagramGet,
  readCookie,
} from '../utils/instagram.js';
import { post, thread, isoDate, linksIn } from './schema.js';

const logger = createLogger('content-instagram');

export const INSTAGRAM_LIMITS = { thread: 0, comments: 0, pages: 1, budgetMs: 20000 };

const POST_PATH = /^(?:\/[^/]+)?\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

export function isInstagramContentUrl(url) {
  return isInstagramPostUrl(url);
}

const shortcodeOf = url => {
  try {
    return POST_PATH.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
};

function mediaOf(item) {
  const items = item.carousel_media?.length ? item.carousel_media : [item];
  return items
    .map(entry => {
      const video = entry.video_versions?.[0]?.url;
      const image = entry.image_versions2?.candidates?.[0]?.url;
      const url = video ?? image;
      if (!url) return null;
      return {
        type: video ? 'video' : 'image',
        url,
        alt: entry.accessibility_caption ?? null,
        width: entry.original_width ?? null,
        height: entry.original_height ?? null,
      };
    })
    .filter(Boolean);
}

export function normalizeInstagramItem(item, shortcode) {
  const text = item.caption?.text ?? '';
  const handle = item.user?.username ?? null;
  return post({
    id: String(item.pk ?? item.id ?? ''),
    url: `https://www.instagram.com/p/${shortcode}/`,
    author: {
      handle,
      name: item.user?.full_name || null,
      url: handle ? `https://www.instagram.com/${handle}/` : null,
    },
    createdAt: isoDate(item.taken_at),
    text,
    media: mediaOf(item),
    links: linksIn(text),
    stats: {
      likes: item.like_count,
      replies: item.comment_count,
      views: item.play_count ?? item.view_count,
    },
    extra: {
      kind: item.carousel_media?.length ? 'carousel' : item.video_versions ? 'video' : 'photo',
    },
  });
}

export async function fetchInstagramThread(url, { get = instagramGet, cookie = readCookie } = {}) {
  const shortcode = isInstagramPostUrl(url) ? shortcodeOf(url) : null;
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) {
    throw new NetworkError('that is not a link to an instagram post', 'BAD_URL', 400);
  }
  const session = cookie();
  if (!session) {
    throw new NetworkError('instagram needs a session to read posts', 'NO_SESSION');
  }
  const data = await get(`/api/v1/media/${mediaId}/info/`, new URL(url).pathname, session);
  const item = data?.items?.[0];
  if (!item) {
    logger.debug(`Instagram returned no item for ${shortcode}`);
    throw new NetworkError(
      'this post is unavailable, it may be deleted or private',
      'CONTENT_GONE'
    );
  }
  const subject = normalizeInstagramItem(item, shortcode);
  return thread({ source: 'instagram', url: subject.url, post: subject, thread: [], comments: [] });
}
