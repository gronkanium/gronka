import { NetworkError, ValidationError, withCause, contentGone } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { fetchPage } from './ssrf-guard.js';
import { normalizeHost } from './url-host.js';

// <blog>.tumblr.com/post/<id> answers bots with a browser check; the same post on
// www.tumblr.com/<blog>/<id> is served whole, with the post as NPF in ___INITIAL_STATE___.
const RESERVED = new Set(['www', 'media', 'api', 'assets', 'static']);

export function parseTumblrUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = normalizeHost(parsed.hostname);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'tumblr.com') {
    const [blog, id] = parts[0] === 'blog' && parts[1] === 'view' ? parts.slice(2) : parts;
    return blog && /^\d+$/.test(id ?? '') ? { blog, id } : null;
  }
  const blog = host.endsWith('.tumblr.com') ? host.slice(0, -'.tumblr.com'.length) : null;
  if (!blog || blog.includes('.') || RESERVED.has(blog)) return null;
  return parts[0] === 'post' && /^\d+$/.test(parts[1] ?? '') ? { blog, id: parts[1] } : null;
}

export const isTumblrUrl = url => parseTumblrUrl(url) !== null;

export function findTumblrPost(html, id) {
  const json = /<script[^>]*id="___INITIAL_STATE___"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!json) return null;
  let route;
  try {
    route = JSON.parse(json).PeeprRoute;
  } catch {
    return null;
  }
  if (route?.postPermalinkIsMissing) throw contentGone(`tumblr: post ${id} is missing`);
  return route?.initialTimeline?.objects?.find(o => o.idString === id) ?? null;
}

// Reblogs keep the original's media in the trail, ahead of the reblogger's own blocks.
export function extractTumblrMedia(post) {
  const blocks = [...(post.trail ?? []).flatMap(t => t.content ?? []), ...(post.content ?? [])];
  return blocks.flatMap(block => {
    if (block.type === 'image') {
      const best = [...(block.media ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
      return best?.url ? [best.url] : [];
    }
    if (block.type === 'video' && block.provider === 'tumblr') {
      const url = block.media?.url ?? block.url;
      return url ? [url] : [];
    }
    return [];
  });
}

export async function downloadFromTumblr(url) {
  const { blog, id } = parseTumblrUrl(url) ?? {};
  if (!id) throw new ValidationError('that is not a link to a tumblr post');
  const pageUrl = `https://www.tumblr.com/${blog}/${id}`;

  const response = await fetchPage(pageUrl, {
    failMessage: 'failed to fetch the tumblr post',
    headers: getRequestHeaders(),
  });

  const post = findTumblrPost(String(response.data ?? ''), id);
  if (!post) {
    throw withCause(
      new NetworkError('failed to read the tumblr post'),
      `tumblr: ${pageUrl} had no post ${id} in its page state`
    );
  }
  const media = extractTumblrMedia(post);
  if (!media.length) {
    throw new ValidationError('this post has no photo or video to download.', 'NO_VIDEO', 422);
  }
  const files = await Promise.all(media.map(item => downloadFileFromUrl(item)));
  return files.length === 1 ? files[0] : files;
}
