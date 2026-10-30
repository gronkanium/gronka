import axios from 'axios';
import { createHash } from 'crypto';
import { NetworkError, ValidationError, withCause, contentGone } from './errors.js';
import { getRequestHeaders } from './discord-cdn.js';
import { downloadFileFromUrl } from './file-downloader.js';
import { maxDownloadBytes, tooLarge } from './size-limit.js';
import { ssrfGuardedRequest, PAGE_FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from './ssrf-guard.js';
import { hostOf, isBilibiliCdnHost } from './url-host.js';

const API = 'https://api.bilibili.com';
// Bilibili's fixed shuffle of the two WBI key halves (from its player script).
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
// view and playurl codes for a deleted, hidden or private video
const GONE_CODES = new Set([-404, 62002, 62004, 62012]);

export function bilibiliVideo(url) {
  try {
    if (!['bilibili.com', 'm.bilibili.com'].includes(hostOf(url))) return null;
    const { pathname, searchParams } = new URL(url);
    const match = pathname.match(/^\/(?:s\/)?video\/(?:(BV[0-9A-Za-z]{10})|av(\d+))\/?$/);
    if (!match) return null;
    const page = Number(searchParams.get('p'));
    return {
      id: match[1] ? { bvid: match[1] } : { aid: match[2] },
      page: Number.isInteger(page) && page > 0 ? page : 1,
    };
  } catch {
    return null;
  }
}

export const isBilibiliUrl = url => bilibiliVideo(url) !== null;

export function wbiKey(imgUrl, subUrl) {
  const stem = u => u.split('/').pop().split('.')[0];
  const raw = stem(imgUrl) + stem(subUrl);
  return MIXIN.map(i => raw[i])
    .join('')
    .slice(0, 32);
}

export function signWbi(params, key, now = Date.now()) {
  const query = new URLSearchParams(
    Object.entries({ ...params, wts: Math.floor(now / 1000) })
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, String(v).replace(/[!'()*]/g, '')])
  ).toString();
  return `${query}&w_rid=${createHash('md5')
    .update(query + key)
    .digest('hex')}`;
}

async function api(path, query) {
  let body;
  try {
    ({ data: body } = await axios.get(`${API}${path}${query ? `?${query}` : ''}`, {
      ...ssrfGuardedRequest(),
      responseType: 'json',
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: MAX_PAGE_BYTES,
      headers: { ...getRequestHeaders(), Referer: 'https://www.bilibili.com/' },
    }));
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) throw contentGone(error);
    if (status === 412 || status === 429) {
      throw withCause(
        new NetworkError('bilibili is blocking downloads right now, try again later'),
        error
      );
    }
    throw withCause(new NetworkError('could not read this bilibili video.'), error);
  }
  return body;
}

function payload(body, path) {
  const why = `bilibili: ${path} answered code ${body?.code}: ${body?.message}`;
  if (GONE_CODES.has(body?.code)) throw contentGone(why);
  if (body?.code !== 0 || !body.data) {
    throw withCause(new NetworkError('could not read this bilibili video.'), why);
  }
  return body.data;
}

const onVideoHost = value => {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && isBilibiliCdnHost(target.hostname);
  } catch {
    return false;
  }
};

// The one file's mirrors, main first; null unless the video is a single file.
export function pickBilibiliFile(play) {
  const files = play?.durl ?? [];
  if (files.length !== 1) return null;
  const urls = [files[0].url, ...(files[0].backup_url ?? [])].filter(onVideoHost);
  return urls.length ? { urls, size: files[0].size } : null;
}

// The html5 player's single-file mp4 (720p, audio included), so nothing needs muxing.
export async function downloadFromBilibili(url, { maxDuration = Infinity } = {}) {
  const video = bilibiliVideo(url);
  if (!video) throw new ValidationError('invalid bilibili video link.');
  const nav = await api('/x/web-interface/nav');
  const img = nav?.data?.wbi_img;
  if (!img?.img_url || !img?.sub_url) {
    throw withCause(
      new NetworkError('could not read this bilibili video.'),
      'bilibili: nav has no wbi_img'
    );
  }
  const key = wbiKey(img.img_url, img.sub_url);
  const view = payload(await api('/x/web-interface/wbi/view', signWbi(video.id, key)), 'view');
  const part = view.pages?.[video.page - 1] ?? { cid: view.cid, duration: view.duration };
  if (part.duration > maxDuration) {
    throw new ValidationError(
      `this video is longer than the maximum allowed (${Math.floor(maxDuration / 60)} minutes).`
    );
  }
  const playParams = { ...video.id, cid: part.cid, qn: 64, fnval: 1, platform: 'html5' };
  const maxSize = await maxDownloadBytes();
  let failed;
  // Mirrors now and then 403 a fresh link or drop the socket; the next mirror or play url serves it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const play = payload(await api('/x/player/wbi/playurl', signWbi(playParams, key)), 'playurl');
    const file = pickBilibiliFile(play);
    if (!file) {
      throw withCause(
        new NetworkError('could not read this bilibili video.'),
        `bilibili: playurl gave ${play.durl?.length ?? 0} files, none single on a bilivideo host`
      );
    }
    if (file.size > maxSize) throw tooLarge(maxSize, `bilibili: playurl says ${file.size} bytes`);
    for (const fileUrl of file.urls) {
      try {
        return await downloadFileFromUrl(fileUrl);
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        failed = error;
      }
    }
  }
  throw failed;
}
