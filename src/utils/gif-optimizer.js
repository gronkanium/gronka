import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { mediaPath } from './storage.js';
import { ValidationError } from './errors.js';
import { botConfig, isOwnCdnUrl, r2Config } from './config.js';
import { downloadGifFromR2, isR2Configured, mediaExistsInR2 } from './r2-storage.js';
import { hashPartsHex } from './hashing.js';
import { fromPath, writeAtomic } from './media-file.js';
const logger = createLogger('gif-optimizer');

export function isGifFile(filename, contentType) {
  const ext = path.extname(filename ?? '').toLowerCase();
  const isGifExt = ext === '.gif';
  const isGifContentType = contentType ? contentType.toLowerCase() === 'image/gif' : false;

  return isGifExt || isGifContentType;
}

const OWN_CDN_PATHS = [
  ['gif', /^\/gifs\/([a-f0-9]+)(\.gif)$/i],
  ['video', /^\/videos\/([a-f0-9]+)(\.(?:mp4|webm|mov|avi|mkv))$/i],
  ['image', /^\/images\/([a-f0-9]+)(\.(?:png|jpg|jpeg|webp))$/i],
];

// {type, hash, ext} for a file on this instance's own CDN, else null.
export function parseOwnCdnUrl(url) {
  try {
    if (!isOwnCdnUrl(url)) return null;
    const { pathname } = new URL(url);
    for (const [type, pattern] of OWN_CDN_PATHS) {
      const match = pathname.match(pattern);
      if (match) return { type, hash: match[1], ext: match[2].toLowerCase() };
    }
  } catch {
    // not a URL
  }
  return null;
}

// A stored gif as a media file from local disk, else from R2; null when neither has it.
export async function loadStoredGif(hash) {
  const local = mediaPath('gif', hash, '.gif', botConfig.gifStoragePath);
  try {
    return await fromPath(local, { contentType: 'image/gif', filename: `${hash}.gif` });
  } catch {
    // not on this disk
  }
  if (!isR2Configured(r2Config) || !(await mediaExistsInR2('gif', hash, '.gif', r2Config))) {
    return null;
  }
  return downloadGifFromR2(hash, r2Config).catch(error => {
    logger.warn(`R2 gif download failed for ${hash}: ${error.message}`);
    return null;
  });
}

// Optimizes a gif once per (content, lossy) pair; returns {hash: its storage key, file}.
export async function optimizeCached(gif, lossy = null) {
  const hash = hashPartsHex([gif.hash, 'optimized', lossy === null ? null : String(lossy)]);
  const stored = await loadStoredGif(hash);
  if (stored) return { hash, file: stored };
  const outputPath = mediaPath('gif', hash, '.gif', botConfig.gifStoragePath);
  await writeAtomic(outputPath, part =>
    optimizeGif(gif.path, part, lossy === null ? {} : { lossy })
  );
  return {
    hash,
    file: await fromPath(outputPath, { contentType: 'image/gif', filename: `${hash}.gif` }),
  };
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

    logger.debug(`GIF optimization completed: ${outputPath}`);
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
