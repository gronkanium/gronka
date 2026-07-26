import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { getGifPath } from './storage.js';
import { ValidationError } from './errors.js';
import { mediaSlots } from './concurrency.js';
const logger = createLogger('gif-optimizer');

export function isGifFile(filename, contentType) {
  const ext = path.extname(filename).toLowerCase();
  const isGifExt = ext === '.gif';
  const isGifContentType = contentType ? contentType.toLowerCase() === 'image/gif' : false;

  return isGifExt || isGifContentType;
}

/**
 * Extract hash from cdn URL (supports gronka.dev subdomains, e.g. cdn.gronka.dev)
 * @param {string} url - URL to parse (e.g., https://cdn.gronka.dev/gifs/abc123.gif)
 * @returns {string|null} Extracted hash or null if not a valid cdn URL
 */
export function extractHashFromCdnUrl(url) {
  try {
    const urlObj = new URL(url);

    // Check if it's a gronka.dev subdomain URL
    if (!urlObj.hostname.endsWith('.gronka.dev')) {
      return null;
    }

    // Parse path patterns: /gifs/{hash}.gif, /videos/{hash}.{ext}, /images/{hash}.{ext}
    const gifPathMatch = urlObj.pathname.match(/^\/gifs\/([a-f0-9]+)\.gif$/i);
    if (gifPathMatch && gifPathMatch[1]) {
      return gifPathMatch[1];
    }

    const videoPathMatch = urlObj.pathname.match(
      /^\/videos\/([a-f0-9]+)\.(mp4|webm|mov|avi|mkv)$/i
    );
    if (videoPathMatch && videoPathMatch[1]) {
      return videoPathMatch[1];
    }

    const imagePathMatch = urlObj.pathname.match(/^\/images\/([a-f0-9]+)\.(png|jpg|jpeg|webp)$/i);
    if (imagePathMatch && imagePathMatch[1]) {
      return imagePathMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

export async function checkLocalGif(hash, storagePath) {
  // Check local filesystem directly, ignoring R2
  // This is used by optimization to determine if we can use a local file
  // instead of downloading from R2/CDN
  try {
    const gifPath = getGifPath(hash, storagePath);
    await fs.access(gifPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Optimize a GIF file using gifsicle
 * gifsicle ships in the app Docker image; running the bot in Docker is the
 * supported setup (outside it, /optimize fails with a clear error).
 * @param {string} inputPath - Path to input GIF file
 * @param {string} outputPath - Path to output optimized GIF file
 * @param {Object} options - Optimization options
 * @param {number} options.lossy - Lossy compression level (0-100, default: 35). Higher = more compression, lower quality
 * @param {number} options.optimize - Optimization level (1-3, default: 3). Higher = better optimization, slower
 * @returns {Promise<void>}
 */
export async function optimizeGif(inputPath, outputPath, options = {}) {
  return mediaSlots.run(() => optimizeGifImpl(inputPath, outputPath, options));
}

async function optimizeGifImpl(inputPath, outputPath, options = {}) {
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

  logger.info(
    `Optimizing GIF: ${inputPath} -> ${outputPath} (lossy: ${lossy}, optimize: ${optimizeLevel})`
  );

  // Validate input file exists
  try {
    await fs.access(inputPath);
  } catch {
    throw new ValidationError(`Input GIF file not found: ${inputPath}`);
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // spawn with an argument array: no shell is involved, so paths need no escaping
  const args = [`--optimize=${optimizeLevel}`, `--lossy=${lossy}`, inputPath, '-o', outputPath];

  try {
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn('gifsicle', args, {
        timeout: 300000, // 5 minute timeout
      });

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
      throw new ValidationError('Optimized GIF file was not created');
    }

    logger.info(`GIF optimization completed: ${outputPath}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    // Log detailed error information for debugging (not shown to user)
    logger.error(
      `GIF optimization failed: ${error.message}${error.stderr ? ` - ${error.stderr}` : ''}`
    );

    if (error.code === 'ENOENT') {
      throw new ValidationError('gifsicle not found. Is it installed and on PATH?');
    }
    if (error.signal === 'SIGTERM') {
      throw new ValidationError('GIF optimization timed out');
    }

    // Return generic error message to user (detailed errors logged above)
    throw new ValidationError('GIF optimization failed. Please try again.');
  }
}

export function calculateSizeReduction(originalSize, optimizedSize) {
  if (originalSize === 0) {
    return 0;
  }

  const reduction = ((originalSize - optimizedSize) / originalSize) * 100;
  return Math.round(reduction);
}

export function formatSizeMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}mb`;
}
