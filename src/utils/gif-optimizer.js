import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { AppError, ValidationError, withCause } from './errors.js';
import { fromPath, tempPath, jobSignal } from './media-file.js';
const logger = createLogger('gif-optimizer');
const OPTIMIZE_FAILED = 'could not optimize this gif, try again.';

export function isGifFile(filename, contentType) {
  const ext = path.extname(filename ?? '').toLowerCase();
  const isGifExt = ext === '.gif';
  const isGifContentType = contentType ? contentType.toLowerCase() === 'image/gif' : false;

  return isGifExt || isGifContentType;
}

// Optimizes a gif into the job dir; returns the optimized media file.
export async function optimizeToJob(gif, lossy = null) {
  const outputPath = await tempPath('.gif');
  await optimizeGif(gif.path, outputPath, lossy === null ? {} : { lossy });
  return fromPath(outputPath, { contentType: 'image/gif', filename: 'gronka.gif' });
}

export async function optimizeGif(inputPath, outputPath, options = {}) {
  const lossy = options.lossy ?? 35;
  const optimizeLevel = options.optimize ?? 3;

  // Validate lossy level (0-100)
  if (typeof lossy !== 'number' || lossy < 0 || lossy > 100) {
    throw new ValidationError('lossy level must be between 0 and 100');
  }

  // Validate optimize level (1-3)
  if (typeof optimizeLevel !== 'number' || optimizeLevel < 1 || optimizeLevel > 3) {
    throw new ValidationError('optimize level must be between 1 and 3');
  }

  logger.debug(
    `Optimizing GIF: ${inputPath} -> ${outputPath} (lossy: ${lossy}, optimize: ${optimizeLevel})`
  );

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    throw withCause(new AppError(OPTIMIZE_FAILED), `gifsicle: input missing at ${inputPath}`);
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // spawn with an argument array: no shell is involved, so paths need no escaping
  const args = [`--optimize=${optimizeLevel}`, `--lossy=${lossy}`, inputPath, '-o', outputPath];

  try {
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn('gifsicle', args, { signal: jobSignal(), timeout: 300000 });

      let stderrData = '';
      child.stderr.on('data', data => {
        stderrData += data.toString();
      });

      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code !== 0) {
          const error = new Error(`gifsicle exited with code ${code}`);
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
      logger.warn(`gifsicle stderr: ${stderr}`);
    }

    // Verify output file was created
    try {
      await fs.access(outputPath);
    } catch {
      throw withCause(new AppError(OPTIMIZE_FAILED), 'gifsicle: exit 0 but no output file');
    }

    logger.debug(`GIF optimization completed: ${outputPath}`);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    // Log detailed error information for debugging (not shown to user)
    logger.error(
      `GIF optimization failed: ${error.message}${error.stderr ? ` - ${error.stderr}` : ''}`
    );

    if (error.signal === 'SIGTERM') {
      throw withCause(new AppError('optimizing this gif took too long and was stopped.'), error);
    }
    throw withCause(
      new AppError(OPTIMIZE_FAILED),
      `gifsicle: ${error.code === 'ENOENT' ? 'not installed' : error.message} ${error.stderr ?? ''}`.trim()
    );
  }
}
