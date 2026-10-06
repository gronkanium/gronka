import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError, withCause, describeCause, contentGone } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest, PAGE_FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from './ssrf-guard.js';
import { normalizeHost } from './url-host.js';

const logger = createLogger('hentaigifz');

// hentaigifz.com is a WordPress gif site (not a Cobalt/yt-dlp service). Each post
// lives at https://hentaigifz.com/<slug>/ and embeds a single animated GIF hosted on
// cdn.hentaigifz.com/<id>/<slug>.gif (which 302-redirects to cdn2.hentaigifz.com).
// We resolve the post page to that CDN URL, then hand off to downloadFileFromUrl,
// which reuses the shared SSRF checks, size caps, browser User-Agent, and redirect
// following. Cloudflare fronts the site and 403s non-browser User-Agents, so the
// page fetch must send one too (getRequestHeaders() already does).
const PAGE_HOST = 'hentaigifz.com';
const MEDIA_HOST = 'hentaigifz.com'; // media lives on cdn.<host> / cdn2.<host>

// Check whether a URL is a hentaigifz.com post page we can extract media from
export function isHentaiGifzUrl(url) {
  try {
    const { hostname } = new URL(url);
    const host = normalizeHost(hostname);
    return host === PAGE_HOST;
  } catch {
    return false;
  }
}

// Extract the primary media URL from a hentaigifz.com post page's HTML
export function extractMediaUrl(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return null;
  }

  // 1. JSON-LD ImageObject contentUrl, the canonical full-quality GIF.
  const jsonLd = html.match(/"@type"\s*:\s*"ImageObject"[^}]*?"contentUrl"\s*:\s*"([^"]+)"/i);
  if (jsonLd?.[1] && isMediaHostUrl(jsonLd[1])) {
    return decodeMediaUrl(jsonLd[1]);
  }

  // 2. The primary post media element: <div class="single-post-media"...><picture>
  //    <img src="...gif">. Grab the <img> src within that block.
  const block = html.match(/class="single-post-media"[\s\S]{0,600}?<img[^>]+src="([^"]+)"/i);
  if (block?.[1] && isMediaHostUrl(block[1])) {
    return decodeMediaUrl(block[1]);
  }

  // 3. og:image fallback (the -scaled.webp still/animation, smaller than the GIF).
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  if (og?.[1] && isMediaHostUrl(og[1])) {
    return decodeMediaUrl(og[1]);
  }

  return null;
}

// Guard that a resolved media URL lives on the hentaigifz CDN, so a compromised or unexpected page can't redirect us at an arbitrary host (SSRF is also caught later by downloadFileFromUrl's validateUrl, but this keeps extraction honest)
function isMediaHostUrl(url) {
  try {
    const { hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return host === MEDIA_HOST || host.endsWith(`.${MEDIA_HOST}`);
  } catch {
    return false;
  }
}

/** Decode HTML entities that show up in scraped attribute URLs (e.g. &amp;). */
function decodeMediaUrl(url) {
  return url.replace(/&amp;/gi, '&');
}

// Download the media from a hentaigifz.com post URL
export async function downloadFromHentaiGifz(url) {
  logger.debug(`Resolving hentaigifz post: ${url}`);

  let html;
  try {
    const response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      maxRedirects: 5,
      headers: getRequestHeaders(),
      validateStatus: status => status >= 200 && status < 400,
    });
    html = response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw contentGone(error);
    }
    if (error.response?.status === 403) {
      throw withCause(new NetworkError('access to this post was denied'), error);
    }
    logger.warn(`Failed to fetch hentaigifz post page: ${describeCause(error)}`);
    throw withCause(new NetworkError('failed to fetch the post page'), error);
  }

  const mediaUrl = extractMediaUrl(html);
  if (!mediaUrl) {
    logger.warn(`No media found on hentaigifz post: ${url}`);
    throw new ValidationError('no downloadable media found on this page');
  }

  logger.debug(`Extracted hentaigifz media URL: ${mediaUrl}`);
  const result = await downloadFileFromUrl(mediaUrl);
  logger.debug(
    `Downloaded hentaigifz media: ${result.filename} (${result.size} bytes, ${result.contentType})`
  );
  return result;
}
