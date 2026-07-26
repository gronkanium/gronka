import { createLogger } from './logger.js';

/**
 * Create a counting semaphore that bounds how many tasks run concurrently. Callers past the
 * cap wait for a slot instead of running immediately.
 * @param {string} name - Label used for logging (e.g. 'yt-dlp')
 * @param {number} max - Maximum concurrent tasks
 * @returns {{run: <T>(fn: () => Promise<T>) => Promise<T>, stats: () => {active:number, queued:number, max:number}}}
 */
export function createSlotLimiter(name, max) {
  const logger = createLogger(`${name}-slots`);

  let active = 0;
  // Queued grant callbacks, each of which claims a slot and resolves its acquire() promise.
  const waiters = [];

  // Hand out slots to as many waiters as capacity allows.
  function pump() {
    while (active < max && waiters.length > 0) {
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

  return {
    /**
     * Run `fn` while holding one of the limited slots. The slot is always released, even if
     * `fn` throws.
     */
    async run(fn) {
      if (active >= max) {
        logger.info(`${name} slots full (${active}/${max}), queuing (waiting: ${waiters.length})`);
      }
      const release = await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },

    /** @returns {{active:number, queued:number, max:number}} Current slot usage. */
    stats() {
      return { active, queued: waiters.length, max };
    },
  };
}

// Bounds concurrent Cobalt downloads. Cobalt buffers responses in RAM and shares the Docker VM
// with Postgres, and hammering it also invites rate limiting. Applied inside cobalt.js so every
// caller is covered — the previous per-call-site queue missed file-downloader.js entirely, which
// left the /convert and /optimize paths uncapped.
export const cobaltSlots = createSlotLimiter('cobalt', 2);

// Bounds concurrent yt-dlp downloads. Each in-flight download reads the whole file into RAM
// (fs.readFile in ytdlp.js) up to MAX_VIDEO_SIZE, so a coordinated burst of big downloads could
// otherwise stack unbounded buffers and OOM the app.
export const ytdlpSlots = createSlotLimiter('yt-dlp', 2);

// Bounds concurrent CPU-heavy media encodes (ffmpeg GIF passes, ImageMagick, gifsicle). Each
// encode pins a core and holds its output — up to hundreds of MB for a full-res/full-fps GIF — in
// memory. Uncapped, a burst of conversions starved the box and left operations making zero
// progress until the 10-minute stuck-operation reaper failed them.
export const mediaSlots = createSlotLimiter('media', 2);
