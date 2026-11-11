import { NetworkError, ValidationError, withCause, contentGone } from './errors.js';
import { fetchPage } from './ssrf-guard.js';
import { downloadDirectMedia } from './file-downloader.js';
import { normalizeHost, hostUnder } from './url-host.js';

export const RULE34_HOSTS = ['rule34.xxx'];

export function rule34PostId(url) {
  try {
    const target = new URL(url);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      !RULE34_HOSTS.includes(normalizeHost(target.hostname)) ||
      target.port ||
      target.username ||
      target.password ||
      target.pathname !== '/index.php'
    ) {
      return null;
    }
    const params = target.searchParams;
    if (['page', 's', 'id'].some(key => params.getAll(key).length !== 1)) return null;
    const id = params.get('id');
    return params.get('page') === 'post' && params.get('s') === 'view' && /^[1-9]\d*$/.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

export const isRule34Url = url => rule34PostId(url) !== null;

function mediaUrl(value) {
  try {
    const target = new URL(value.replaceAll('&amp;', '&'), 'https://rule34.xxx/');
    if (
      target.protocol === 'https:' &&
      hostUnder(target.hostname, RULE34_HOSTS) &&
      !target.port &&
      !target.username &&
      !target.password &&
      /^\/+images\/\d+\/[^/]+\.(?:png|jpe?g|gif|webp|mp4|webm)$/i.test(target.pathname)
    ) {
      return target.href;
    }
  } catch {
    return null;
  }
  return null;
}

const attribute = (tag, name) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'))?.[2];

export function extractRule34Media(html) {
  if (typeof html !== 'string') return null;
  for (const match of html.matchAll(/<a\b[^>]*>\s*Original image\s*<\/a>/gi)) {
    const original = mediaUrl(attribute(match[0], 'href'));
    if (original) return original;
  }
  const video = html.match(/<video\b[^>]*\bid=["']gelcomVideoPlayer["'][^>]*>[\s\S]*?<\/video>/i);
  if (video) {
    for (const match of video[0].matchAll(/<(?:video|source)\b[^>]*>/gi)) {
      const source = mediaUrl(attribute(match[0], 'src'));
      if (source) return source;
    }
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (attribute(match[0], 'id') !== 'image') continue;
    const image = mediaUrl(attribute(match[0], 'src'));
    if (image) return image;
  }
  return null;
}

export async function downloadFromRule34(url) {
  const id = rule34PostId(url);
  if (!id) throw new ValidationError('invalid rule34 post link.');
  const page = `https://rule34.xxx/index.php?page=post&s=view&id=${id}`;
  const response = await fetchPage(page, {
    failMessage: 'could not read this rule34 post.',
    impersonate: true,
    onError: error => {
      if ([403, 429].includes(error.response?.status)) {
        throw withCause(
          new NetworkError('rule34 is blocking downloads right now, try again later'),
          error
        );
      }
    },
  });
  const media = extractRule34Media(response.data);
  if (!media) {
    if (/<title>[^<]*(?:captcha|just a moment)/i.test(response.data)) {
      throw withCause(
        new NetworkError('rule34 is blocking downloads right now, try again later'),
        `rule34: post ${id} answered with a CAPTCHA page`
      );
    }
    if (/This post (?:was|has been) deleted|No image with that ID/i.test(response.data)) {
      throw contentGone(`rule34: post ${id} was deleted`);
    }
    throw withCause(
      new NetworkError('could not read this rule34 post.'),
      `rule34: post ${id} has no original image or video`
    );
  }
  return downloadDirectMedia(media);
}
