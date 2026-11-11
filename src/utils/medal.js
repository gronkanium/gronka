import { setTimeout as sleep } from 'node:timers/promises';
import { ValidationError, contentGone, notPublishedYet } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { fetchPage } from './ssrf-guard.js';
import { hostOf } from './url-host.js';

export function medalClipId(url) {
  try {
    const { pathname, searchParams } = new URL(url);
    if (hostOf(url) !== 'medal.tv') return null;
    const id =
      pathname.match(/\/clips?\/([A-Za-z0-9_-]+)/)?.[1] ?? searchParams.get('contentId') ?? null;
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const isMedalUrl = url => medalClipId(url) !== null;

export function pickMedalVideo(clip) {
  for (const key of ['contentUrl', 'contentUrl1080p', 'contentUrl720p', 'socialMediaVideo']) {
    const value = clip?.[key];
    try {
      const target = new URL(value);
      if (target.protocol === 'https:' && target.hostname === 'cdn.medal.tv') return value;
    } catch {
      continue;
    }
  }
  return null;
}

// Links are usually shared the second a clip is made; Medal publishes it a few seconds later.
const PUBLISH_RETRY_DELAYS_MS = [2000, 4000, 8000];

async function fetchPublishedClip(id) {
  const { data: clip } = await fetchPage(`https://medal.tv/api/content/${id}`, {
    failMessage: 'could not read this Medal clip.',
    responseType: 'json',
    headers: getRequestHeaders(),
  });
  if (clip?.processed === 0 || clip?.publishedAt == null) {
    throw notPublishedYet(`medal: clip ${id} has no publishedAt yet`);
  }
  return clip;
}

// A 403 is a clip still publishing or Medal refusing us, so once the wait is over yt-dlp gets the link.
const mayStillPublish = error =>
  error.code === 'CLIP_NOT_PUBLISHED' || error.cause?.response?.status === 403;

export async function downloadFromMedal(url, retryDelaysMs = PUBLISH_RETRY_DELAYS_MS) {
  const id = medalClipId(url);
  if (!id) throw new ValidationError('invalid Medal clip link.');
  let clip;
  for (let attempt = 0; !clip; attempt++) {
    try {
      clip = await fetchPublishedClip(id);
    } catch (error) {
      if (!mayStillPublish(error) || attempt >= retryDelaysMs.length) throw error;
      await sleep(retryDelaysMs[attempt]);
    }
  }
  const videoUrl = pickMedalVideo(clip);
  if (!videoUrl) throw contentGone(`medal: clip ${id} has no cdn.medal.tv video url`);
  return downloadFileFromUrl(videoUrl);
}
