import { spawn } from 'child_process';
import { createLogger } from '../logger.js';
import { FFMPEG_INPUT_GUARD } from './utils.js';
import { jobSignal } from '../media-file.js';

const logger = createLogger('video-metadata');

// ffprobe hangs on some malformed input; fail fast instead of waiting for the stuck-job reaper.
const FFPROBE_TIMEOUT_MS = 30000;

// Get video metadata via ffprobe
export async function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      ...FFMPEG_INPUT_GUARD,
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const child = spawn('ffprobe', args, {
      signal: jobSignal(),
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
        // ffprobe emits format.duration as a string ("2.000000"); "N/A" stays as is.
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
