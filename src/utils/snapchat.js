import { NetworkError, withCause } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { fetchPage } from './ssrf-guard.js';
import { withExtension } from './media-file.js';

const SPOTLIGHT_PATH = /^\/(?:@[\w.-]+\/)?spotlight\/[\w-]+/i;

export function isSnapchatSpotlightUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return /^(?:www\.)?snapchat\.com$/i.test(hostname) && SPOTLIGHT_PATH.test(pathname);
  } catch {
    return false;
  }
}

// yt-dlp and cobalt read Snapchat's old Next.js data; the page still carries the file in og:video.
export function spotlightVideoUrl(html) {
  const tag = /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i.exec(html ?? '');
  if (!tag) return null;
  const url = tag[1].replaceAll('&amp;', '&');
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && /(^|\.)sc-cdn\.net$/i.test(hostname) ? url : null;
  } catch {
    return null;
  }
}

export async function downloadFromSnapchat(url) {
  const page = await fetchPage(url, { failMessage: 'could not load this snapchat spotlight.' });
  const video = spotlightVideoUrl(page.data);
  if (!video) {
    throw withCause(
      new NetworkError('could not download this snapchat spotlight.'),
      `snapchat: no og:video on ${new URL(url).pathname}`
    );
  }
  // The CDN names files like abc.27.IRZXSOY; og:video:type says mp4.
  return withExtension({ ...(await downloadFileFromUrl(video)), filename: 'snapchat.mp4' });
}
