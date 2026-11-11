import { fetchTweetThread } from '../content/twitter.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ValidationError, withCause } from './errors.js';
import { hostOf } from './url-host.js';

const X_HOST = /(^|\.)(x|twitter)\.com$|^t\.co$/;

// A post with no media falls back to its card image: old twitpic photos exist only there.
export async function downloadFromX(url, { gql } = {}) {
  const { post } = await fetchTweetThread(url, { thread: false, ...(gql && { gql }) });
  const card = post.extra?.cardImage;
  if (!post.media?.length && card) return downloadFileFromUrl(card);
  if (!post.media?.length) {
    // Tweets from before t.co (2009 and earlier) keep their links as plain text.
    const links = [...(post.links ?? []), ...(post.text?.match(/https?:\/\/\S+/g) ?? [])];
    const linked = links.map(hostOf).find(host => host && !X_HOST.test(host));
    const quoted = post.quoted
      ? `, quoting post ${post.quoted.id} with ${post.quoted.media.length} media`
      : '';
    throw withCause(
      new ValidationError(
        linked
          ? `this post has no photo or video, only a link to ${linked}.`
          : 'this post has no photo or video to download.',
        'NO_VIDEO',
        422
      ),
      `x returned post ${post.id} with no media entities and no card image${quoted}`
    );
  }
  const files = await Promise.all(post.media.map(item => downloadFileFromUrl(item.url)));
  return files.length === 1 ? files[0] : files;
}
