import dns from 'dns';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { NetworkError, withCause, contentGone, describeCause } from './errors.js';
import { blockedAddressReason, validateUrl } from './validation.js';
import { jobSignal } from './media-file.js';

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

// Scraped pages: a slow or huge one is a broken or hostile site, not a page worth waiting for.
export const PAGE_FETCH_TIMEOUT_MS = 20000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

// Axios config fragment to spread into any request whose URL came from user input
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

const PAGE_FETCH_SCRIPT = fileURLToPath(new URL('../../scripts/fetch-page.py', import.meta.url));

async function impersonatedPage(url, headers) {
  const signal = jobSignal(AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS));
  for (let hop = 0; hop <= 5; hop++) {
    guardedBeforeRedirect({ href: url });
    const target = new URL(url);
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = await new Promise((resolve, reject) =>
      guardedLookup(hostname, { all: true }, (error, found) =>
        error ? reject(error) : resolve(found)
      )
    );
    const pinned = addresses
      .map(({ address }) => (address.includes(':') ? `[${address}]` : address))
      .join(',');
    const response = await new Promise((resolve, reject) => {
      const child = execFile(
        'python3',
        [PAGE_FETCH_SCRIPT],
        { signal, maxBuffer: MAX_PAGE_BYTES * 6 + 65536 },
        (error, stdout) => {
          if (error) return reject(error);
          try {
            const result = JSON.parse(stdout);
            if (result.error) {
              reject(Object.assign(new Error(result.error), { code: result.code }));
            } else resolve(result);
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          url,
          headers: headers ?? {},
          resolve: `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}:${pinned}`,
          timeoutMs: PAGE_FETCH_TIMEOUT_MS,
          maxBytes: MAX_PAGE_BYTES,
        })
      );
    }).catch(error => {
      error.config = { url };
      if (signal.reason?.name === 'TimeoutError') error.code = 'ETIMEDOUT';
      throw error;
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      const next = new URL(response.headers.location, url);
      if (next.origin !== target.origin) headers = undefined;
      url = next.href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { response, config: { url } });
    }
    return response;
  }
  throw new Error('page exceeded the redirect limit');
}

// curl exit codes from the impersonated fetch: connect, partial, timeout, TLS, empty reply, send, recv.
const CURL_TRANSIENT = [7, 18, 28, 35, 52, 55, 56];
const ERRNO_TRANSIENT = ['ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED'];
const isTransientPageError = error =>
  error?.response?.status >= 500 || [...CURL_TRANSIENT, ...ERRNO_TRANSIENT].includes(error?.code);

// A source's page or API: one retry on a transient failure, 404/410 means gone, onError may throw a site's own reason, else failMessage.
export async function fetchPage(
  url,
  { failMessage, headers, responseType = 'text', onError, impersonate = false, redirects = 5 } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (impersonate) return await impersonatedPage(url, headers);
      return await axios.get(url, {
        ...ssrfGuardedRequest(),
        responseType,
        timeout: PAGE_FETCH_TIMEOUT_MS,
        maxContentLength: MAX_PAGE_BYTES,
        maxRedirects: redirects,
        validateStatus: status => status >= 200 && status < (redirects ? 300 : 400),
        headers,
      });
    } catch (error) {
      if (impersonate) error.config ??= { url };
      if (attempt === 0 && isTransientPageError(error)) {
        logger.warn(`Page fetch failed, retrying: ${describeCause(error)}`);
        continue;
      }
      if ([404, 410].includes(error.response?.status)) throw contentGone(error);
      onError?.(error);
      throw withCause(new NetworkError(failMessage), error);
    }
  }
}
