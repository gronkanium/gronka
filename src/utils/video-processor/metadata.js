import { spawn } from 'child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('video-metadata');

// ffprobe returns in well under a second on a readable file; a hang means a
// malformed/streaming input it can neither parse nor error on. Bound it so a bad
// input fails fast with a real error instead of blocking the whole conversion
// until the 10-minute stuck-operation reaper notices. Input-agnostic: the timer
// applies to every file, keyed on nothing about the input itself.
const FFPROBE_TIMEOUT_MS = 30000;

/**
 * Get video metadata via ffprobe.
 *
 * Spawns ffprobe directly (rather than fluent-ffmpeg's `ffprobe`) so the timeout
 * can actually SIGKILL the child on a hang — fluent-ffmpeg doesn't expose the
 * process handle, so a stuck probe there would leak. Output shape matches the
 * `-show_format -show_streams` JSON consumers already read (`.format`, `.streams`).
 * @param {string} inputPath - Path to input video file
 * @returns {Promise<Object>} Parsed ffprobe metadata ({ format, streams })
 */
export async function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const child = spawn('ffprobe', args, {
      timeout: FFPROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
      stdout += data.toString();
    });
    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      reject(new Error(`Failed to read video metadata: ${err.message}`, { cause: err }));
    });

    child.on('close', (code, signal) => {
      // spawn's timeout kills with our killSignal, surfacing here as a signal.
      if (signal) {
        logger.warn(
          `ffprobe killed (${signal}) after ${FFPROBE_TIMEOUT_MS / 1000}s on ${inputPath}`
        );
        reject(new Error(`Video metadata read timed out after ${FFPROBE_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Failed to read video metadata: ffprobe exited with code ${code}${
              stderr ? `: ${stderr.trim()}` : ''
            }`
          )
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // ffprobe emits format.duration as a string ("2.000000"); the previous
        // fluent-ffmpeg impl returned it as a number. Coerce so consumers doing
        // numeric comparisons/arithmetic behave exactly as before. Leave "N/A"
        // (non-finite) untouched.
        if (parsed.format && parsed.format.duration !== undefined) {
          const d = Number(parsed.format.duration);
          if (Number.isFinite(d)) parsed.format.duration = d;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse video metadata: ${err.message}`, { cause: err }));
      }
    });
  });
}
