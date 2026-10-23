import axios from 'axios';
import { createLogger } from './logger.js';
import { hostOf } from './url-host.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';
import { validateUrl } from './validation.js';

const logger = createLogger('short-links');

const SHORT_LINK_HOSTS = new Set(['share.google', 'vm.tiktok.com', 'vt.tiktok.com']);

const pathOf = url => new URL(url).pathname;
// facebook.com/share/ links redirect to the post; extractors only read the post url.
const isShortLink = (url, host) =>
  SHORT_LINK_HOSTS.has(host) ||
  (host === 'tiktok.com' && pathOf(url).startsWith('/t/')) ||
  ((host === 'facebook.com' || host === 'm.facebook.com') && pathOf(url).startsWith('/share/'));

// A Google image result carries the image itself in imgurl.
function googleImage(url, host) {
  if (!/^google\.[a-z.]+$/.test(host) || pathOf(url) !== '/imgres') return null;
  const image = new URL(url).searchParams.get('imgurl');
  return image && validateUrl(image).valid ? image : null;
}

export async function resolveShortLink(url) {
  const host = hostOf(url);
  if (!host) return url;
  const image = googleImage(url, host);
  if (image) return image;
  if (!isShortLink(url, host)) return url;

  try {
    const response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      timeout: 10000,
      maxRedirects: 5,
      responseType: 'stream',
      validateStatus: () => true,
    });
    response.data.destroy();
    return response.request?.res?.responseUrl ?? url;
  } catch (error) {
    logger.warn(`Could not resolve short link on ${host}: ${error.message}`);
    return url;
  }
}
