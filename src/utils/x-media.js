import { fetchTweetThread } from '../content/twitter.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ValidationError } from './errors.js';
import { hostOf } from './url-host.js';

const X_HOST = /(^|\.)(x|twitter)\.com$|^t\.co$/;

// X's own web api (the content reader), tried after cobalt. It sees every photo, gif and video
// on a post; a post with none falls back to its link card's image (an old tweet whose photo was
// a twitpic link shows it only that way), and with no card either it says so, instead of
// yt-dlp's "no video formats".
export async function downloadFromX(url, { gql } = {}) {
  const { post } = await fetchTweetThread(url, { thread: false, ...(gql && { gql }) });
  const card = post.extra?.cardImage;
  if (!post.media?.length && card) return downloadFileFromUrl(card);
  if (!post.media?.length) {
    // Tweets from before t.co (2009 and earlier) keep their links as plain text.
    const links = [...(post.links ?? []), ...(post.text?.match(/https?:\/\/\S+/g) ?? [])];
    const linked = links.map(hostOf).find(host => host && !X_HOST.test(host));
    throw new ValidationError(
      linked
        ? `this post has no photo or video, only a link to ${linked}.`
        : 'this post has no photo or video to download.',
      'NO_VIDEO',
      422
    );
  }
  const files = await Promise.all(post.media.map(item => downloadFileFromUrl(item.url)));
  return files.length === 1 ? files[0] : files;
}
