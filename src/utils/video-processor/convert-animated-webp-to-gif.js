import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger.js';
import { validateNumericParameter, MAX_GIF_WIDTH, FFMPEG_TIMEOUT_MS } from './utils.js';
import { jobSignal } from '../media-file.js';

const logger = createLogger('convert-animated-webp-to-gif');

// ImageMagick because FFmpeg 5.1 cannot demux animated WebP; -coalesce rebuilds partial frames.
export async function convertAnimatedWebpToGif(inputPath, outputPath, options = {}) {
  return convertAnimatedWebpToGifImpl(inputPath, outputPath, options);
}

async function convertAnimatedWebpToGifImpl(inputPath, outputPath, options = {}) {
  // Validate width only when the caller asked to resize; otherwise preserve native size.
  const width =
    options.width === undefined || options.width === null
      ? null
      : validateNumericParameter(options.width, 'width', 1, MAX_GIF_WIDTH);

  logger.debug(
    `Starting animated WebP to GIF conversion: ${inputPath} -> ${outputPath}${
      width ? ` (width: ${width})` : ' (native size)'
    }`
  );

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    logger.error(`Input WebP file not found: ${inputPath}`);
    throw new Error(`Input WebP file not found: ${inputPath}`);
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // spawn with an argument array: no shell is involved, so paths need no escaping.
  // -coalesce must precede -resize so frames are flattened before scaling.
  const args = [inputPath, '-coalesce'];
  if (width) {
    args.push('-resize', `${width}x`);
  }
  args.push(outputPath);

  try {
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn('convert', args, {
        signal: jobSignal(),
        timeout: FFMPEG_TIMEOUT_MS,
      });

      let stderrData = '';
      child.stderr.on('data', data => {
        stderrData += data.toString();
      });

      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code !== 0) {
          const error = new Error(`ImageMagick convert exited with code ${code}`);
          error.code = code;
          error.signal = signal;
          error.stderr = stderrData;
          reject(error);
        } else {
          resolve(stderrData);
        }
      });
    });

    if (stderr) {
      logger.warn(`ImageMagick stderr: ${stderr}`);
    }

    // Verify output file was created
    try {
      await fs.access(outputPath);
    } catch {
      throw new Error('Animated WebP conversion produced no output file');
    }

    logger.debug(`Animated WebP to GIF conversion completed: ${outputPath}`);
  } catch (error) {
    // Log detailed error (not shown to user, curated upstream per the error policy)
    logger.error(
      `Animated WebP to GIF conversion failed: ${error.message}${
        error.stderr ? ` - ${error.stderr}` : ''
      }`
    );

    if (error.code === 'ENOENT') {
      throw new Error('ImageMagick (convert) not found. Is it installed and on PATH?', {
        cause: error,
      });
    }
    if (error.signal === 'SIGTERM') {
      throw new Error('Animated WebP conversion timed out', { cause: error });
    }

    throw new Error(`Animated WebP conversion failed: ${error.message}`, { cause: error });
  }
}
