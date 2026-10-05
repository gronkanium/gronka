import axios from 'axios';
import { createLogger } from './logger.js';
import { hostOf } from './url-host.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('short-links');

const SHORT_LINK_HOSTS = new Set(['share.google']);

export async function resolveShortLink(url) {
  const host = hostOf(url);
  if (!SHORT_LINK_HOSTS.has(host)) return url;

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
