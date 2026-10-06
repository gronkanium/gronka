import axios from 'axios';
import { readSessionCookie } from './session-cookie.js';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError, withCause, contentGone } from './errors.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { ssrfGuardedRequest, PAGE_FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from './ssrf-guard.js';
import { hostOf } from './url-host.js';

const logger = createLogger('deviantart');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const STATE = /window\.__INITIAL_STATE__ = JSON\.parse\("((?:\\.|[^"\\])*)"\)/;

const readCookie = () => readSessionCookie('deviantart', 'auth_secure=');

export function deviationId(url) {
  try {
    const host = hostOf(url);
    if (host !== 'deviantart.com' && !host.endsWith('.deviantart.com')) return null;
    return new URL(url).pathname.match(/\/art\/(?:[^/]*-)?(\d+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export const isDeviationUrl = url => deviationId(url) !== null;

export function parseState(html) {
  const literal = html.match(STATE)?.[1];
  if (!literal) return null;
  return JSON.parse(JSON.parse(`"${literal.replace(/\\\\|\\'/g, m => (m === "\\'" ? "'" : m))}"`));
}

// Best video that fits, else the full-size image; null when the page only offers blurred previews.
export function pickMedia(deviation, maxSize = Infinity) {
  const media = deviation?.media;
  const types = media?.types ?? [];
  const videos = types.filter(t => t.t === 'video' && t.b).sort((a, b) => b.h - a.h);
  if (videos.length > 0) {
    return (videos.find(v => !v.f || v.f <= maxSize) ?? videos.at(-1)).b;
  }
  const full = types.find(t => t.t === 'fullview');
  if (!full || !media.baseUri || /blur_\d+/.test(full.c ?? '')) return null;
  const path = full.c ? full.c.replace('<prettyName>', media.prettyName) : '';
  const token = media.token?.[0];
  return `${media.baseUri}${path}${token ? `?token=${token}` : ''}`;
}

export async function downloadFromDeviantArt(url, maxSize = Infinity) {
  const id = deviationId(url);
  const cookie = readCookie();
  let html;
  try {
    const response = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'text',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      headers: { 'User-Agent': USER_AGENT, ...(cookie && { Cookie: cookie }) },
    });
    html = response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw contentGone(error);
    }
    throw withCause(new NetworkError('failed to reach DeviantArt'), error);
  }

  let state;
  try {
    state = parseState(html);
  } catch (error) {
    throw withCause(new NetworkError('could not read this DeviantArt page'), error);
  }
  const deviation = state?.['@@entities']?.deviation?.[id];
  if (!deviation) {
    throw withCause(
      new NetworkError('could not read this DeviantArt page'),
      `deviantart: deviation ${id} missing from page state`
    );
  }
  const mediaUrl = pickMedia(deviation, maxSize);
  if (!mediaUrl) {
    const loggedIn = state['@@publicSession']?.isLoggedIn === true;
    if (deviation.isMature && !loggedIn) {
      throw withCause(
        new ValidationError(
          'this deviation is marked mature, and DeviantArt only shows it to logged in accounts.'
        ),
        cookie
          ? 'deviantart: session cookie rejected, page is logged out'
          : 'deviantart: mature deviation, no session configured'
      );
    }
    throw withCause(
      new ValidationError(
        `this deviation is a ${deviation.type ?? 'post'} with no image or video to download.`
      ),
      `deviantart: no video or fullview for type ${deviation.type}`
    );
  }
  logger.debug(`DeviantArt ${id}: ${mediaUrl.split('?')[0]}`);
  return downloadFileFromUrl(mediaUrl);
}
