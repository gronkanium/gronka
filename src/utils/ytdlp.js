import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import tmp from 'tmp';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';

const logger = createLogger('ytdlp');

/**
 * Custom error for yt-dlp rate limiting
 */
export class YtdlpRateLimitError extends NetworkError {
  constructor(message, retryAfter = null) {
    super(message);
    this.name = 'YtdlpRateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Check if a URL is from YouTube
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is from YouTube
 */
export function isYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return (
      hostname === 'youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'm.youtube.com' ||
      hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

/**
 * Get content type from file extension
 * @param {string} ext - File extension (with or without dot)
 * @returns {string} MIME type
 */
function getContentType(ext) {
  const extLower = ext.toLowerCase().replace(/^\./, '');
  const mimeTypes = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return mimeTypes[extLower] || 'video/mp4';
}

/**
 * Execute yt-dlp command and return the output file path
 * @param {string} url - YouTube URL to download
 * @param {string} outputDir - Directory to save the file
 * @param {string} quality - Quality format string for yt-dlp
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string>} Path to downloaded file
 */
function executeYtdlp(url, outputDir, quality, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      '-f',
      quality,
      '--merge-output-format',
      'mp4',
      '-o',
      outputTemplate,
      '--restrict-filenames',
      '--print',
      'after_move:filepath',
      url,
    ];

    logger.info(`Executing yt-dlp with args: ${args.join(' ')}`);

    const ytdlp = spawn('yt-dlp', args, {
      timeout: timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', data => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', data => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      ytdlp.kill('SIGKILL');
      reject(new NetworkError('yt-dlp download timed out'));
    }, timeout);

    ytdlp.on('close', code => {
      clearTimeout(timeoutId);

      if (code === 0) {
        // yt-dlp prints the output file path via --print after_move:filepath
        // Filter out any progress messages and get only valid file paths
        const lines = stdout
          .trim()
          .split('\n')
          .map(line => line.trim())
          .filter(line => {
            // Filter out progress messages and keep only file paths
            return (
              line.length > 0 &&
              !line.startsWith('[download]') &&
              !line.includes('ETA') &&
              !line.includes('MiB') &&
              !line.includes('KiB') &&
              !line.includes('%') &&
              (line.startsWith('/') || line.startsWith('./') || line.includes(outputDir))
            );
          });

        const outputPath = lines.length > 0 ? lines[lines.length - 1] : null;

        if (outputPath && outputPath.length > 0) {
          // Verify the file actually exists
          try {
            const stats = fsSync.statSync(outputPath);
            if (stats.isFile()) {
              logger.info(`yt-dlp download complete: ${outputPath}`);
              resolve(outputPath);
            } else {
              reject(new NetworkError(`yt-dlp output path is not a file: ${outputPath}`));
            }
          } catch (statError) {
            // If statSync fails, try to find the file in the output directory
            const files = fsSync.readdirSync(outputDir);
            if (files.length > 0) {
              const actualPath = path.join(outputDir, files[0]);
              logger.info(`yt-dlp download complete (found file): ${actualPath}`);
              resolve(actualPath);
            } else {
              reject(
                new NetworkError(
                  `yt-dlp output file not found at ${outputPath}: ${statError.message}`
                )
              );
            }
          }
        } else {
          // Fallback: try to find the file in the output directory
          try {
            const files = fsSync.readdirSync(outputDir);
            if (files.length > 0) {
              const actualPath = path.join(outputDir, files[0]);
              logger.info(`yt-dlp download complete (fallback): ${actualPath}`);
              resolve(actualPath);
            } else {
              reject(new NetworkError('yt-dlp did not return output file path'));
            }
          } catch (readError) {
            reject(
              new NetworkError(
                `yt-dlp did not return output file path and could not read output directory: ${readError.message}`
              )
            );
          }
        }
      } else {
        const errorOutput = stderr || stdout;
        logger.error(`yt-dlp failed with code ${code}: ${errorOutput}`);

        // Check for common error patterns
        if (errorOutput.includes('HTTP Error 429') || errorOutput.includes('Too Many Requests')) {
          reject(new YtdlpRateLimitError('YouTube rate limit exceeded', 5 * 60 * 1000));
        } else if (
          errorOutput.includes('Video unavailable') ||
          errorOutput.includes('Private video')
        ) {
          reject(new NetworkError('video is unavailable or private'));
        } else if (errorOutput.includes('Sign in to confirm your age')) {
          reject(new NetworkError('video requires age verification'));
        } else if (errorOutput.includes('is not a valid URL')) {
          reject(new ValidationError('invalid YouTube URL'));
        } else if (errorOutput.includes('No video formats found')) {
          reject(new NetworkError('no downloadable video formats found'));
        } else {
          reject(new NetworkError(`yt-dlp failed: ${errorOutput.substring(0, 200)}`));
        }
      }
    });

    ytdlp.on('error', err => {
      clearTimeout(timeoutId);
      if (err.code === 'ENOENT') {
        reject(new NetworkError('yt-dlp is not installed or not in PATH'));
      } else {
        reject(new NetworkError(`yt-dlp process error: ${err.message}`));
      }
    });
  });
}

/**
 * Download video from YouTube using yt-dlp
 * @param {string} url - YouTube URL to download
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files and higher quality)
 * @param {number} maxSize - Maximum file size in bytes
 * @param {string} quality - Quality preference (default from config)
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
export async function downloadFromYouTube(
  url,
  isAdminUser = false,
  maxSize = Infinity,
  quality = null
) {
  logger.info(`Downloading from YouTube: ${url} (admin: ${isAdminUser})`);

  // Use appropriate quality based on user type
  // Admin users get best quality, regular users get 1080p max
  const effectiveQuality =
    quality ||
    (isAdminUser
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]');

  // Create temporary directory for download
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });

  try {
    // Execute yt-dlp
    const outputPath = await executeYtdlp(url, tmpDir.name, effectiveQuality);

    // Read the downloaded file
    const buffer = await fs.readFile(outputPath);

    // Check file size
    if (!isAdminUser && buffer.length > maxSize) {
      throw new ValidationError(
        `file is too large (${(buffer.length / (1024 * 1024)).toFixed(2)}MB, max ${(maxSize / (1024 * 1024)).toFixed(2)}MB)`
      );
    }

    // Get file info - filename is only used for extension extraction, not for user-facing purposes
    // The actual filename used will be hash-based in the download command
    const filename = path.basename(outputPath);
    const ext = path.extname(outputPath);
    const contentType = getContentType(ext);

    logger.info(
      `Successfully downloaded YouTube video, size: ${buffer.length} bytes, content-type: ${contentType}, extension: ${ext}`
    );

    return {
      buffer,
      contentType,
      size: buffer.length,
      filename, // Only used for extension extraction in download command, not user-facing
    };
  } catch (error) {
    logger.error(`YouTube download failed: ${error.message}`);
    throw error;
  } finally {
    // Clean up temp directory
    try {
      tmpDir.removeCallback();
    } catch (cleanupError) {
      logger.warn(`Failed to clean up temp directory: ${cleanupError.message}`);
    }
  }
}

/**
 * Check if yt-dlp is available on the system
 * @returns {Promise<boolean>} True if yt-dlp is available
 */
export async function isYtdlpAvailable() {
  return new Promise(resolve => {
    const ytdlp = spawn('yt-dlp', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    ytdlp.on('close', code => {
      resolve(code === 0);
    });

    ytdlp.on('error', () => {
      resolve(false);
    });
  });
}
