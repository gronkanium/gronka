import dns from 'dns';
import { createLogger } from './logger.js';
import { blockedAddressReason, validateUrl } from './validation.js';

const logger = createLogger('ssrf-guard');

// Marker on errors raised by this guard, so callers can tell a refused destination apart
// from an ordinary network failure.
export const SSRF_BLOCKED_CODE = 'ESSRFBLOCKED';

// Curated message for a refused destination. Names no internals, just why we stopped.
export const BLOCKED_DESTINATION_MESSAGE =
  'that url points to a private or internal address, which is not allowed.';

// dns.lookup replacement that refuses to hand back an address the bot must not connect to
export function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }

    const resolved = Array.isArray(addresses) ? addresses : [addresses];
    for (const entry of resolved) {
      const blocked = blockedAddressReason(entry.address);
      if (blocked) {
        logger.warn(`Refused request to ${hostname} (${entry.address}): ${blocked}`);
        const refusal = new Error(`request to ${hostname} is not allowed: ${blocked}`);
        refusal.code = SSRF_BLOCKED_CODE;
        callback(refusal);
        return;
      }
    }

    if (options?.all) {
      callback(null, resolved);
      return;
    }
    callback(null, resolved[0].address, resolved[0].family);
  });
}

// beforeRedirect hook that re-validates each hop
export function guardedBeforeRedirect(options) {
  const target = options.href ?? `${options.protocol}//${options.hostname}${options.path ?? ''}`;
  const validation = validateUrl(target);
  if (!validation.valid) {
    logger.warn(`Refused redirect to ${target}: ${validation.error}`);
    const refusal = new Error(`redirect to ${target} is not allowed: ${validation.error}`);
    refusal.code = SSRF_BLOCKED_CODE;
    throw refusal;
  }
}

// Whether a request failure came from this guard
export function isSsrfBlockedError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === SSRF_BLOCKED_CODE) return true;
    current = current.cause;
  }
  return false;
}

// Axios config fragment to spread into any request whose URL came from user input
// Scraped pages: a slow or huge one is a broken or hostile site, not a page worth waiting for.
export const PAGE_FETCH_TIMEOUT_MS = 20000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export function ssrfGuardedRequest() {
  return {
    lookup: guardedLookup,
    beforeRedirect: guardedBeforeRedirect,
  };
}

// yt-dlp and cobalt fetch whatever they are handed, so a name that resolves into our own
// network is refused before any downloader sees it. A lookup failure is left to the downloader.
export function isPrivateHost(url) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return new Promise(resolve =>
    guardedLookup(hostname, { all: true }, error => resolve(error?.code === SSRF_BLOCKED_CODE))
  );
}
