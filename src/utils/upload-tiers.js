import { fileURLToPath } from 'url';
import assert from 'assert';

// Size-based retention: bigger R2 uploads expire sooner so the shared bucket stays under its
// (soft) budget. R2 bills on the average of daily-peak storage, so short TTLs on big files
// keep that peak - and the bill - down. The curve is steerable via the `upload_ttl_tiers`
// bot setting; this is the fallback when the setting is unset or malformed.
//
// Format: comma-separated `MB:hours` pairs, ascending by size. A file uses the first tier
// whose size ceiling it fits under; anything larger than the last tier gets that last (shortest)
// TTL. Files above the hard MAX_VIDEO_SIZE ceiling are rejected before they ever reach here.
export const DEFAULT_TTL_TIERS = '100:72,250:24,500:8,1024:2';

const MB = 1024 * 1024;

/**
 * Parse a tier string into ascending [{ maxBytes, hours }]. Returns null on any malformed
 * input so callers can fall back to DEFAULT_TTL_TIERS instead of trusting garbage.
 * @param {string} str
 * @returns {Array<{maxBytes:number, hours:number}>|null}
 */
export function parseTiers(str) {
  if (typeof str !== 'string' || str.trim() === '') {
    return null;
  }
  const tiers = [];
  for (const pair of str.split(',')) {
    const m = /^(\d{1,6}):(\d{1,5})$/.exec(pair.trim());
    if (!m) {
      return null;
    }
    const mb = parseInt(m[1], 10);
    const hours = parseInt(m[2], 10);
    if (mb <= 0 || hours <= 0) {
      return null;
    }
    tiers.push({ maxBytes: mb * MB, hours });
  }
  tiers.sort((a, b) => a.maxBytes - b.maxBytes);
  return tiers;
}

/**
 * TTL in hours for a file of the given size under the given tier string.
 * Falls back to the default curve when tiersStr is unusable.
 * @param {number} bytes
 * @param {string} [tiersStr]
 * @returns {number} whole hours
 */
export function ttlHoursForSize(bytes, tiersStr = DEFAULT_TTL_TIERS) {
  const tiers = parseTiers(tiersStr) || parseTiers(DEFAULT_TTL_TIERS);
  for (const tier of tiers) {
    if (bytes <= tier.maxBytes) {
      return tier.hours;
    }
  }
  // Larger than every tier ceiling: use the shortest (last) TTL.
  return tiers[tiers.length - 1].hours;
}

// Runnable self-check: `node src/utils/upload-tiers.js`
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  // Default curve boundaries.
  assert.equal(ttlHoursForSize(50 * MB), 72, '50MB -> 3 days');
  assert.equal(ttlHoursForSize(100 * MB), 72, '100MB (boundary) -> 3 days');
  assert.equal(ttlHoursForSize(100 * MB + 1), 24, 'just over 100MB -> 24h');
  assert.equal(ttlHoursForSize(500 * MB), 8, '500MB -> 8h');
  assert.equal(ttlHoursForSize(1024 * MB), 2, '1GB -> 2h');
  assert.equal(ttlHoursForSize(2048 * MB), 2, 'over top tier -> shortest TTL');
  // Malformed / empty settings fall back to the default curve.
  assert.equal(ttlHoursForSize(50 * MB, 'garbage'), 72, 'malformed -> default');
  assert.equal(ttlHoursForSize(50 * MB, ''), 72, 'empty -> default');
  assert.equal(parseTiers('100:0'), null, 'zero hours rejected');
  assert.equal(parseTiers('0:5'), null, 'zero MB rejected');
  // Custom curve, order-independent.
  assert.equal(ttlHoursForSize(300 * MB, '500:6,100:48'), 6, 'custom curve, unsorted input');
  console.log('upload-tiers self-check passed');
}
