import { ValidationError, contentGone } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { normalizeHost } from './url-host.js';

const POST_ID = /^[\w-]{10,}$/;

// youtube.com/post/<id>, or the older channel community tab with ?lb=<id>.
export function youtubePostId(url) {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    if (!['youtube.com', 'm.youtube.com'].includes(normalizeHost(hostname))) return null;
    const id =
      pathname.match(/^\/post\/([\w-]+)/)?.[1] ??
      (/\/(?:community|posts)\/?$/.test(pathname) ? searchParams.get('lb') : null);
    return id && POST_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function findPost(value, id) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const post = findPost(item, id);
      if (post) return post;
    }
  } else if (value && typeof value === 'object') {
    if (value.backstagePostRenderer?.postId === id) return value.backstagePostRenderer;
    for (const item of Object.values(value)) {
      const post = findPost(item, id);
      if (post) return post;
    }
  }
  return null;
}

// =s0 asks yt3.ggpht.com for the original upload instead of a cropped thumbnail.
const originalImage = renderer => {
  const url = renderer?.image?.thumbnails?.at(-1)?.url;
  return url ? url.replace(/=[^/]*$/, '=s0') : null;
};

// { images, videoId } for the post, or null when the page does not carry it.
export function extractYoutubePost(html, id) {
  const json = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!json) return null;
  let post;
  try {
    post = findPost(JSON.parse(json), id);
  } catch {
    return null;
  }
  if (!post) return null;
  const attachment = post.backstageAttachment ?? {};
  const renderers = attachment.postMultiImageRenderer?.images?.map(
    image => image.backstageImageRenderer
  ) ?? [attachment.backstageImageRenderer];
  return {
    images: renderers.map(originalImage).filter(Boolean),
    videoId: attachment.videoRenderer?.videoId ?? null,
  };
}

export async function resolveYoutubePost(id) {
  const response = await fetchPage(`https://www.youtube.com/post/${id}`, {
    failMessage: 'failed to reach youtube',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const post = extractYoutubePost(response.data, id);
  if (!post) throw contentGone('youtube: page had no post data');
  if (!post.videoId && post.images.length === 0) {
    throw new ValidationError('this youtube post has no image or video to download.');
  }
  return post;
}
