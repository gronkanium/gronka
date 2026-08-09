import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('pinterest');

// Pinterest has no working upstream extractor: Cobalt 11 answers error.api.fetch.empty and
// yt-dlp's extractor has been broken since ~2025-06 (Pinterest serves a fake 404 to its own
// resource API even for public pins — yt-dlp #13554). The pin *page* is still fully public
// though, and renders schema.org JSON-LD carrying a direct progressive MP4 for video pins
// and the originals-size image for image pins. That is what this extractor reads: the
// blocked resource API is never touched, and neither is the HLS/DASH ladder next to it.
//
// Deliberately JSON-LD and not Pinterest's embedded Relay payload: the Relay blobs are
// URI-encoded JSON inside window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__() calls keyed by
// query hash, which churns with every frontend deploy. JSON-LD is a public SEO contract.
const MEDIA_HOST = 'pinimg.com';
const PAGE_FETCH_TIMEOUT_MS = 20000;

// Pin pages live on pinterest.com and its regional variants — both the it./br./de. style
// subdomains and the ccTLD style (pinterest.co.uk, pinterest.ca). pin.it is the share
// shortener, whose links redirect to a canonical /pin/<id>/ page.
const PINTEREST_HOST = /(^|\.)pinterest\.[a-z]{2,}(\.[a-z]{2,})?$/;
const PIN_PATH = /^\/pin\/\d+/;

/**
 * Check whether a URL is a Pinterest pin we can extract media from: a /pin/<id> page on any
 * pinterest domain, or a pin.it share link (whose path is an opaque slug).
 * @param {string} url - URL to check
 * @returns {boolean} True if the URL is a pin page or a pin.it share link
 */
export function isPinterestUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'pin.it') {
      return pathname.length > 1;
    }
    return PINTEREST_HOST.test(host) && PIN_PATH.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Extract the primary media URL from a pin page's HTML.
 * Video pins carry a JSON-LD VideoObject whose contentUrl is a progressive MP4; image pins
 * carry a SocialMediaPosting whose image is the originals-size asset. Video wins when both
 * are present, since a video pin also publishes its still as the posting image.
 * @param {string} html - Raw HTML of the pin page
 * @returns {string|null} Absolute media URL on the Pinterest CDN, or null if none found
 */
export function extractMediaUrl(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return null;
  }

  let image = null;
  for (const match of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (data?.['@type'] === 'VideoObject' && isMediaHostUrl(data.contentUrl)) {
      return data.contentUrl;
    }
    if (data?.['@type'] === 'SocialMediaPosting' && !image && isMediaHostUrl(data.image)) {
      image = data.image;
    }
  }

  return image;
}

/**
 * Guard that a resolved media URL lives on the Pinterest CDN, so an unexpected page shape
 * can't point us at an arbitrary host (SSRF is also caught later by downloadFileFromUrl's
 * validateUrl, but this keeps extraction honest).
 * @param {unknown} url - Candidate media URL
 * @returns {boolean}
 */
function isMediaHostUrl(url) {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === MEDIA_HOST || host.endsWith(`.${MEDIA_HOST}`);
  } catch {
    return false;
  }
}

/**
 * Download the media for a Pinterest pin URL.
 * Fetches the pin page (following the pin.it redirect when present), reads the media URL out
 * of its JSON-LD, then downloads it via the shared file-downloader (reusing SSRF validation,
 * size limits, and content-type/filename detection). Returns the same { buffer, contentType,
 * size, filename } shape as the other download paths.
 * @param {string} url - Pinterest pin or pin.it URL
 * @param {boolean} isAdminUser - Admin users bypass size limits
 * @returns {Promise<{buffer: Buffer, contentType: string, size: number, filename: string}>}
 */
export async function downloadFromPinterest(url, isAdminUser = false) {
  logger.info(`Resolving Pinterest pin: ${url}`);

  let response;
  try {
    response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      headers: getRequestHeaders(),
      validateStatus: status => status >= 200 && status < 400,
    });
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 410) {
      throw new NetworkError('this pin is unavailable or has been deleted');
    }
    logger.warn(`Failed to fetch Pinterest pin page: ${error.message}`);
    throw new NetworkError('failed to fetch the pin page');
  }

  // A dead pin.it link is answered with a 200, not a 404: Pinterest redirects it to the
  // regional home page with ?show_error=true. Detect that here so the user is told the pin
  // is gone rather than the misleading "no downloadable media" below.
  const finalUrl = response.request?.res?.responseUrl || url;
  if (finalUrl.includes('show_error=true')) {
    throw new NetworkError('this pin is unavailable or has been deleted');
  }

  const mediaUrl = extractMediaUrl(response.data);
  if (!mediaUrl) {
    logger.warn(`No media found on Pinterest pin: ${finalUrl}`);
    throw new ValidationError('no downloadable media found on this pin');
  }

  logger.info(`Extracted Pinterest media URL: ${mediaUrl}`);
  const result = await downloadFileFromUrl(mediaUrl, isAdminUser);
  logger.info(
    `Downloaded Pinterest media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
