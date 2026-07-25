import dns from 'dns';
import { createLogger } from './logger.js';
import { blockedAddressReason, validateUrl } from './validation.js';

const logger = createLogger('ssrf-guard');

// Marker on errors raised by this guard, so callers can tell a refused destination apart
// from an ordinary network failure.
export const SSRF_BLOCKED_CODE = 'ESSRFBLOCKED';

/**
 * dns.lookup replacement that refuses to hand back an address the bot must not connect to.
 *
 * validateUrl only sees the URL string, so a hostname that resolves into the private
 * network (attacker-controlled DNS, `foo.localtest.me`, a Docker service name) sails past
 * it. This runs on the addresses the connection will actually use, and — because the
 * option is reused for every hop — on redirect targets too.
 * @param {string} hostname - Hostname being resolved
 * @param {Object} options - dns.lookup options supplied by the HTTP agent
 * @param {Function} callback - Node lookup callback
 */
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

/**
 * beforeRedirect hook that re-validates each hop. The DNS guard already blocks the
 * connection itself; this rejects a redirect earlier and with a clearer log, and catches
 * hops that switch to a protocol we never want to follow.
 * @param {Object} options - Redirect request options from follow-redirects
 */
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

/**
 * Whether a request failure came from this guard. The refusal is raised inside the DNS
 * lookup or the redirect hook, so axios and follow-redirects wrap it — walk the cause
 * chain rather than checking the outermost code.
 * @param {Error} error - Error thrown by a guarded request
 * @returns {boolean} True when the destination was refused by the guard
 */
export function isSsrfBlockedError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === SSRF_BLOCKED_CODE) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Axios config fragment to spread into any request whose URL came from user input.
 *
 * Usage: `axios.get(url, { ...ssrfGuardedRequest(), responseType: 'arraybuffer' })` —
 * always alongside a validateUrl check on the URL itself.
 *
 * Deliberately NOT used in cobalt.js: those requests target the Cobalt API and its tunnel
 * URLs on the Docker network (private addresses on purpose), and the URLs come from
 * Cobalt's own response rather than from the user.
 * @returns {{lookup: Function, beforeRedirect: Function}} Guard options
 */
export function ssrfGuardedRequest() {
  return {
    lookup: guardedLookup,
    beforeRedirect: guardedBeforeRedirect,
  };
}
