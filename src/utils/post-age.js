import { hostOf } from './url-host.js';

const FRESH_MS = 10 * 60 * 1000;
const X_EPOCH_MS = 1288834974657n;

// X snowflakes and TikTok ids both carry their creation time; other links return null.
function postedAt(url) {
  const host = hostOf(url);
  if (!host) return null;
  const path = new URL(url).pathname;
  if (['x.com', 'twitter.com'].includes(host)) {
    const id = /\/status\/(\d{15,20})/.exec(path)?.[1];
    return id ? Number((BigInt(id) >> 22n) + X_EPOCH_MS) : null;
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const id = /\/(?:video|photo)\/(\d{15,20})/.exec(path)?.[1];
    return id ? Number(BigInt(id) >> 32n) * 1000 : null;
  }
  return null;
}

// Sites answer "unavailable" for a few minutes after a post goes up.
export function isFreshPost(url, now = Date.now()) {
  const at = postedAt(url);
  return at !== null && now - at < FRESH_MS;
}
