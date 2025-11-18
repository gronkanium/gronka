import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { gifExists, getGifPath } from './storage.js';
import { ValidationError } from './errors.js';

const execAsync = promisify(exec);
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
  const isGifContentType = contentType && contentType.toLowerCase() === 'image/gif';
  
  return isGifExt || isGifContentType;
}

/**
 * Extract hash from cdn.p1x.dev URL
 * @param {string} url - URL to parse (e.g., https://cdn.p1x.dev/gifs/abc123.gif)
 * @returns {string|null} Extracted hash or null if not a valid cdn.p1x.dev URL
 */
export function extractHashFromCdnUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // Check if it's a cdn.p1x.dev URL
    if (urlObj.hostname !== 'cdn.p1x.dev' && !urlObj.hostname.endsWith('.p1x.dev')) {
      return null;
    }
    
    // Parse path pattern: /gifs/{hash}.gif
    const pathMatch = urlObj.pathname.match(/^\/gifs\/([a-f0-9]+)\.gif$/i);
    if (pathMatch && pathMatch[1]) {
      return pathMatch[1];
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a GIF exists locally in storage
 * @param {string} hash - Hash of the GIF file
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if GIF exists locally
 */
export async function checkLocalGif(hash, storagePath) {
  return await gifExists(hash, storagePath);
}

/**
 * Optimize a GIF file using giflossy docker container
 * @param {string} inputPath - Path to input GIF file
 * @param {string} outputPath - Path to output optimized GIF file
 * @returns {Promise<void>}
 */
export async function optimizeGif(inputPath, outputPath) {
  logger.info(`Optimizing GIF: ${inputPath} -> ${outputPath}`);
  
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
  
  // Use docker run with --volumes-from to inherit volumes
  // gifsicle command: gifsicle --optimize=3 --lossy=80 input.gif -o output.gif
  const command = `docker run --rm --volumes-from ${containerName} dylanninin/giflossy:latest /bin/gifsicle --optimize=3 --lossy=80 "${inputDockerPath}" -o "${outputDockerPath}"`;
  
  try {
    logger.debug(`Executing: ${command}`);
    const { stdout, stderr } = await execAsync(command, {
      timeout: 300000, // 5 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
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

