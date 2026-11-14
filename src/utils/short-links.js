import axios from 'axios';
import { createLogger } from './logger.js';
import { hostOf } from './url-host.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';
import { validateUrl } from './validation.js';
import { routeFor } from '../core/sources.js';

const logger = createLogger('short-links');

const SHORT_LINK_HOSTS = new Set([
  'share.google',
  't.co',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'b23.tv',
  'spotify.link',
  'spotify.app.link',
  'on.soundcloud.com',
  'nico.ms',
]);

const pathOf = url => new URL(url).pathname;
const isGoogle = host => /^google\.[a-z.]+$/.test(host);
// facebook.com/share/ and google.com/goto links only reveal their target by redirecting to it.
export const isShortLink = (url, host = hostOf(url)) =>
  SHORT_LINK_HOSTS.has(host) ||
  ((host === 'tiktok.com' || host === 'lite.tiktok.com') && pathOf(url).startsWith('/t/')) ||
  ((host === 'facebook.com' || host === 'm.facebook.com') && pathOf(url).startsWith('/share/')) ||
  (isGoogle(host) && pathOf(url) === '/goto');

const valid = target => (target && validateUrl(target).valid ? target : null);

// Google result links carry their target in the query: a page in imgrefurl, q or url, an image in imgurl.
function googleTarget(url, host) {
  if (!isGoogle(host)) return null;
  const { pathname, searchParams } = new URL(url);
  if (pathname === '/imgres') {
    // A video result's imgurl is its thumbnail, so a page a source can read wins.
    const page = valid(searchParams.get('imgrefurl'));
    return page && routeFor(page) ? page : valid(searchParams.get('imgurl'));
  }
  return pathname === '/url' ? valid(searchParams.get('q') ?? searchParams.get('url')) : null;
}

export async function resolveShortLink(url) {
  const host = hostOf(url);
  if (!host) return url;
  const target = googleTarget(url, host);
  if (target) return target;
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
