import { createLogger } from './logger.js';

const logger = createLogger('ytdlp-queue');

// Bounds concurrent yt-dlp downloads. Each in-flight download reads the whole file into RAM
// (fs.readFile in ytdlp.js) up to MAX_VIDEO_SIZE, and — unlike the Cobalt path, which is capped
// in cobalt-queue.js — this path was previously uncapped. A coordinated burst of big downloads
// could therefore stack unbounded buffers and OOM the app (which shares the Docker VM with
// Postgres and Cobalt). Capping peak concurrency keeps memory bounded regardless of traffic;
// requests past the cap wait for a slot instead of running immediately.
const MAX_CONCURRENT_YTDLP = 2;

let active = 0;
// Queued grant callbacks, each of which claims a slot and resolves its acquire() promise.
const waiters = [];

// Hand out slots to as many waiters as capacity allows.
function pump() {
  while (active < MAX_CONCURRENT_YTDLP && waiters.length > 0) {
    const grant = waiters.shift();
    grant();
  }
}

// Resolve with a single-use release function so a double-release can't over-decrement the count.
function acquire() {
  return new Promise(resolve => {
    const grant = () => {
      active++;
      let released = false;
      resolve(() => {
        if (released) {
          return;
        }
        released = true;
        active--;
        pump();
      });
    };
    waiters.push(grant);
    pump();
  });
}

/**
 * Run `fn` while holding one of the limited yt-dlp download slots. Extra calls queue until a
 * slot frees. The slot is always released, even if `fn` throws.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runInYtdlpSlot(fn) {
  if (active >= MAX_CONCURRENT_YTDLP) {
    logger.info(
      `yt-dlp slots full (${active}/${MAX_CONCURRENT_YTDLP}), queuing (waiting: ${waiters.length})`
    );
  }
  const release = await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * @returns {{active:number, queued:number, max:number}} Current slot usage.
 */
export function getYtdlpQueueStats() {
  return { active, queued: waiters.length, max: MAX_CONCURRENT_YTDLP };
}
