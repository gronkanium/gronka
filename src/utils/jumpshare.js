import { NetworkError, ValidationError, withCause } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { fetchPage } from './ssrf-guard.js';

function shareId(url) {
  try {
    const { hostname, pathname, protocol } = new URL(url);
    if (!['http:', 'https:'].includes(protocol)) return null;
    if (hostname !== 'jumpshare.com' && hostname !== 'www.jumpshare.com') return null;
    return pathname.match(/^\/(?:s|share)\/([A-Za-z0-9]+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export const isJumpshareUrl = url => shareId(url) !== null;

export function extractJumpshareUrl(html, id) {
  if (typeof html !== 'string') return null;
  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const attrs = Object.fromEntries(
      [...tag[0].matchAll(/\s([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [
        match[1].toLowerCase(),
        match[3],
      ])
    );
    if (!attrs.class?.split(/\s+/).includes('download') || attrs['data-id'] !== id) continue;
    try {
      const target = new URL(attrs['data-link']?.replaceAll('&amp;', '&'));
      if (
        target.protocol === 'https:' &&
        target.hostname === 'cdn.jumpshare.com' &&
        !target.port &&
        !target.username &&
        !target.password &&
        target.pathname.startsWith('/download/')
      ) {
        return target.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveJumpshareUrl(url) {
  const id = shareId(url);
  if (!id) throw new ValidationError('invalid Jumpshare file link.');
  const response = await fetchPage(url, {
    failMessage: 'could not read this Jumpshare link.',
    headers: getRequestHeaders(),
  });
  const mediaUrl = extractJumpshareUrl(response.data, id);
  if (!mediaUrl) {
    throw withCause(
      new NetworkError(
        'no downloadable file found on this Jumpshare page. it may be private or expired.'
      ),
      'jumpshare: share page has no original download URL for the requested file'
    );
  }
  return mediaUrl;
}
