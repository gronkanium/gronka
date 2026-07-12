import { createLogger } from './logger.js';

const logger = createLogger('media-processing-queue');

// Bounds concurrent CPU-heavy media encodes (ffmpeg GIF passes, ImageMagick, gifsicle). Each
// encode pins a core and holds its output — up to hundreds of MB for a full-res/full-fps GIF — in
// memory, and unlike the download paths (capped in cobalt-queue.js / ytdlp-queue.js) this work was
// previously uncapped. A burst of conversions therefore stacked concurrent encodes, starved the
// box, and left operations making zero progress until the 10-minute stuck-operation reaper failed
// them. Capping peak concurrency keeps CPU/memory bounded regardless of traffic; requests past the
// cap wait for a slot instead of piling on.
const MAX_CONCURRENT_MEDIA = 2;

let active = 0;
// Queued grant callbacks, each of which claims a slot and resolves its acquire() promise.
const waiters = [];

// Hand out slots to as many waiters as capacity allows.
function pump() {
  while (active < MAX_CONCURRENT_MEDIA && waiters.length > 0) {
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
 * Run `fn` while holding one of the limited media-processing slots. Extra calls queue until a
 * slot frees. The slot is always released, even if `fn` throws.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runInMediaSlot(fn) {
  if (active >= MAX_CONCURRENT_MEDIA) {
    logger.info(
      `media slots full (${active}/${MAX_CONCURRENT_MEDIA}), queuing (waiting: ${waiters.length})`
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
export function getMediaQueueStats() {
  return { active, queued: waiters.length, max: MAX_CONCURRENT_MEDIA };
}
