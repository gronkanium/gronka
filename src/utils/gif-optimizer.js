import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { getGifPath } from './storage.js';
import { ValidationError } from './errors.js';
const logger = createLogger('gif-optimizer');

/**
 * Check if a file is a GIF based on extension and content type
 * @param {string} filename - File name
 * @param {string} contentType - Content type (MIME type)
 * @returns {boolean} True if file is a GIF
 */
export function isGifFile(filename, contentType) {
  const ext = path.extname(filename).toLowerCase();
  const isGifExt = ext === '.gif';
  const isGifContentType = contentType ? contentType.toLowerCase() === 'image/gif' : false;

  return isGifExt || isGifContentType;
}

/**
 * Extract hash from cdn URL (supports cdn.gronka.p1x.dev and other p1x.dev subdomains)
 * @param {string} url - URL to parse (e.g., https://cdn.gronka.p1x.dev/gifs/abc123.gif)
 * @returns {string|null} Extracted hash or null if not a valid cdn URL
 */
export function extractHashFromCdnUrl(url) {
  try {
    const urlObj = new URL(url);

    // Check if it's a p1x.dev subdomain URL
    if (!urlObj.hostname.endsWith('.p1x.dev')) {
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

/**
 * Check if a GIF exists locally in storage (bypasses R2 check)
 * @param {string} hash - Hash of the GIF file
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if GIF exists locally on disk
 */
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
 * Optimize a GIF file using giflossy docker container
 * @param {string} inputPath - Path to input GIF file
 * @param {string} outputPath - Path to output optimized GIF file
 * @param {Object} options - Optimization options
 * @param {number} options.lossy - Lossy compression level (0-100, default: 35). Higher = more compression, lower quality
 * @param {number} options.optimize - Optimization level (1-3, default: 3). Higher = better optimization, slower
 * @returns {Promise<void>}
 */
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
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  // Get absolute paths - these are container paths inside /app
  const inputAbsPath = path.resolve(inputPath);
  const outputAbsPath = path.resolve(outputPath);

  // Map container paths to paths inside the giflossy container
  // Both containers will use the same paths since we'll inherit volumes
  const cwd = process.cwd(); // This is /app inside the container
  let inputDockerPath = inputAbsPath;
  let outputDockerPath = outputAbsPath;

  if (inputAbsPath.startsWith(cwd)) {
    inputDockerPath = inputAbsPath.replace(cwd, '/app');
  }
  if (outputAbsPath.startsWith(cwd)) {
    outputDockerPath = outputAbsPath.replace(cwd, '/app');
  }

  // Use --volumes-from to inherit all volumes from the current container
  // This way we don't need to know the host paths
  // Container name is 'gronka' as defined in docker-compose.yml
  const containerName = 'gronka';

  // Validate paths don't contain shell metacharacters (additional safety check)
  // Paths are already validated via path.resolve() and normalized, but add extra validation
  const shellMetaChars = /[;&|`$(){}[\]*?~<>\\\n\r\t\0]/;
  if (shellMetaChars.test(inputDockerPath) || shellMetaChars.test(outputDockerPath)) {
    throw new ValidationError('Invalid characters in file paths');
  }

  // Use docker run with --volumes-from to inherit volumes
  // gifsicle command: gifsicle --optimize=3 --lossy=35 input.gif -o output.gif (default lossy: 35)
  // SECURITY: Use spawn with array arguments to prevent command injection
  // This avoids shell execution and passes arguments directly to docker
  const dockerArgs = [
    'run',
    '--rm',
    '--volumes-from',
    containerName,
    'dylanninin/giflossy:latest',
    '/bin/gifsicle',
    `--optimize=${optimizeLevel}`,
    `--lossy=${lossy}`,
    inputDockerPath,
    '-o',
    outputDockerPath,
  ];

  try {
    logger.debug(`Executing: docker ${dockerArgs.join(' ')}`);
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('docker', dockerArgs, {
        timeout: 300000, // 5 minute timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', data => {
        stdoutData += data.toString();
      });

      child.stderr.on('data', data => {
        stderrData += data.toString();
      });

      child.on('error', reject);

      child.on('close', code => {
        if (code !== 0) {
          const error = new Error(`docker process exited with code ${code}`);
          error.code = code;
          error.stderr = stderrData;
          reject(error);
        } else {
          resolve({ stdout: stdoutData, stderr: stderrData });
        }
      });
    });

    if (stderr && !stderr.includes('warning')) {
      logger.warn(`giflossy stderr: ${stderr}`);
    }

    if (stdout) {
      logger.debug(`giflossy stdout: ${stdout}`);
    }

    // Verify output file was created
    try {
      await fs.access(outputPath);
      logger.info(`GIF optimization completed: ${outputPath}`);
    } catch {
      throw new ValidationError('Optimized GIF file was not created');
    }
  } catch (error) {
    logger.error(`GIF optimization failed: ${error.message}`);
    if (error.code === 'ENOENT') {
      throw new ValidationError('docker command not found. Is Docker installed?');
    }
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
      throw new ValidationError('GIF optimization timed out');
    }
    throw new ValidationError(`GIF optimization failed: ${error.message}`);
  }
}

/**
 * Calculate size reduction percentage
 * @param {number} originalSize - Original file size in bytes
 * @param {number} optimizedSize - Optimized file size in bytes
 * @returns {number} Size reduction percentage (negative if file grew)
 */
export function calculateSizeReduction(originalSize, optimizedSize) {
  if (originalSize === 0) {
    return 0;
  }

  const reduction = ((originalSize - optimizedSize) / originalSize) * 100;
  return Math.round(reduction);
}

/**
 * Format file size in MB
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size (e.g., "6.7mb")
 */
export function formatSizeMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}mb`;
}
