import { NetworkError, withCause } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { fetchPage } from './ssrf-guard.js';
import { withExtension } from './media-file.js';

const SPOTLIGHT_PATH = /^\/(?:@[\w.-]+\/)?spotlight\/[\w-]+/i;
const SHARE_PATH = /^\/m\/[\w-]+/;

export function isSnapchatMediaUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      (/^(?:www\.)?snapchat\.com$/i.test(hostname) && SPOTLIGHT_PATH.test(pathname)) ||
      (/^share\.snapchat\.com$/i.test(hostname) && SHARE_PATH.test(pathname))
    );
  } catch {
    return false;
  }
}

const onSnapCdn = url => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && /(^|\.)sc-cdn\.net$/i.test(hostname);
  } catch {
    return false;
  }
};

// yt-dlp and cobalt read Snapchat's old Next.js data; the page still carries the file in og:video.
export function spotlightVideoUrl(html) {
  const tag = /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i.exec(html ?? '');
  const url = tag?.[1].replaceAll('&amp;', '&');
  return url && onSnapCdn(url) ? url : null;
}

// A shared memory (share.snapchat.com/m/) has no og:video; its Next.js data lists the files.
export function sharedSnapMedia(html) {
  const json = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html ?? '')?.[1];
  let media;
  try {
    media = JSON.parse(json).props.pageProps.mediaData.batchMediaShare.media;
  } catch {
    return [];
  }
  return (Array.isArray(media) ? media : [])
    .filter(item => onSnapCdn(item?.url))
    .map(item => ({ url: item.url, ext: item.__typename === 'Video' ? 'mp4' : 'jpg' }));
}

export async function downloadFromSnapchat(url) {
  const page = await fetchPage(url, { failMessage: 'could not load this snapchat link.' });
  const video = spotlightVideoUrl(page.data);
  // The CDN names files like abc.27.IRZXSOY, so the extension comes from the page.
  const files = video ? [{ url: video, ext: 'mp4' }] : sharedSnapMedia(page.data);
  if (!files.length) {
    throw withCause(
      new NetworkError('could not download this snapchat link.'),
      `snapchat: no og:video or shared media on ${new URL(url).pathname}`
    );
  }
  const downloaded = await Promise.all(
    files.map(async file =>
      withExtension({ ...(await downloadFileFromUrl(file.url)), filename: `snapchat.${file.ext}` })
    )
  );
  return downloaded.length === 1 ? downloaded[0] : downloaded;
}
