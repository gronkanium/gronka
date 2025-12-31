import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import tmp from 'tmp';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { trimVideo } from './video-processor/trim-video.js';

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
 * Convert seconds to HH:MM:SS.ss format for yt-dlp --download-sections
 * yt-dlp can misinterpret plain numbers >= 60 as MM:SS format,
 * so we use explicit timestamp format to avoid ambiguity.
 * @param {number|string} seconds - Time in seconds or 'inf' for infinity
 * @returns {string} Formatted timestamp (e.g., "00:01:23.50" or "inf")
 */
export function formatTimestamp(seconds) {
  if (seconds === 'inf') return 'inf';
  const totalSeconds = Number(seconds);
  if (isNaN(totalSeconds)) return 'inf';

  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  // Format as HH:MM:SS.ss (with 2 decimal places for sub-second precision)
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

/**
 * Execute yt-dlp command and return the output file path
 * @param {string} url - YouTube URL to download
 * @param {string} outputDir - Directory to save the file
 * @param {string} quality - Quality format string for yt-dlp
 * @param {number} timeout - Timeout in milliseconds
 * @param {number} maxDuration - Maximum video duration in seconds (default: 180 = 3 minutes)
 * @param {number|null} startTime - Start time in seconds for segment download
 * @param {number|null} duration - Duration in seconds for segment download
 * @returns {Promise<string>} Path to downloaded file
 */
function executeYtdlp(
  url,
  outputDir,
  quality,
  timeout = 300000,
  maxDuration = 180,
  startTime = null,
  duration = null
) {
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
    ];

    // only filter by duration if:
    // - maxDuration is not Infinity AND
    // - no time-based segment download requested (startTime or duration specified)
    if (maxDuration !== Infinity && startTime === null && duration === null) {
      args.push('--match-filter', `duration <= ${maxDuration}`);
    }

    // use yt-dlp's --download-sections to download ONLY the requested segment
    // this prevents downloading huge files when user only wants a small clip
    // IMPORTANT: Use explicit HH:MM:SS.ss format to avoid yt-dlp misinterpreting
    // plain numbers >= 60 as MM:SS format (e.g., 123 interpreted as 1:23 = 83 seconds)
    // NOTE: We always require explicit duration - 'inf' doesn't work reliably with HH:MM:SS format
    // The caller (downloadFromYouTube) calculates the actual duration when only startTime is provided
    if (startTime !== null || duration !== null) {
      const start = startTime || 0;
      const end = start + (duration || 0);
      const startFormatted = formatTimestamp(start);
      const endFormatted = formatTimestamp(end);
      args.push('--download-sections', `*${startFormatted}-${endFormatted}`);
      args.push('--force-keyframes-at-cuts'); // cleaner segment extraction
    }

    args.push('-o', outputTemplate, '--restrict-filenames', '--print', 'after_move:filepath', url);

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
        // Check if video was filtered out due to duration limit
        // yt-dlp exits with code 0 when --match-filter skips a video
        const combinedOutput = stdout + stderr;
        if (
          combinedOutput.includes('does not pass filter') ||
          combinedOutput.includes('Video is longer than') ||
          combinedOutput.includes('Skipping')
        ) {
          reject(new ValidationError('video duration exceeds the maximum allowed (3 minutes)'));
          return;
        }

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
          // Verify the file actually exists and has valid content
          try {
            const stats = fsSync.statSync(outputPath);
            if (stats.isFile()) {
              // Check for minimum file size - a valid video should be at least 1KB
              // A 200-byte file is just container headers with no actual video data
              const MIN_VALID_VIDEO_SIZE = 1024; // 1KB minimum
              if (stats.size < MIN_VALID_VIDEO_SIZE) {
                logger.error(
                  `yt-dlp produced a suspiciously small file (${stats.size} bytes), likely a failed segment download`
                );
                reject(
                  new NetworkError(
                    `yt-dlp segment download failed: output file too small (${stats.size} bytes)`
                  )
                );
                return;
              }
              logger.info(`yt-dlp download complete: ${outputPath} (${stats.size} bytes)`);
              resolve(outputPath);
            } else {
              reject(new NetworkError(`yt-dlp output path is not a file: ${outputPath}`));
            }
          } catch (statError) {
            // If statSync fails, try to find the file in the output directory
            const files = fsSync.readdirSync(outputDir);
            if (files.length > 0) {
              const actualPath = path.join(outputDir, files[0]);
              const fallbackStats = fsSync.statSync(actualPath);
              const MIN_VALID_VIDEO_SIZE = 1024;
              if (fallbackStats.size < MIN_VALID_VIDEO_SIZE) {
                logger.error(
                  `yt-dlp produced a suspiciously small file (${fallbackStats.size} bytes), likely a failed segment download`
                );
                reject(
                  new NetworkError(
                    `yt-dlp segment download failed: output file too small (${fallbackStats.size} bytes)`
                  )
                );
                return;
              }
              logger.info(
                `yt-dlp download complete (found file): ${actualPath} (${fallbackStats.size} bytes)`
              );
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
              const fallbackStats = fsSync.statSync(actualPath);
              const MIN_VALID_VIDEO_SIZE = 1024;
              if (fallbackStats.size < MIN_VALID_VIDEO_SIZE) {
                logger.error(
                  `yt-dlp produced a suspiciously small file (${fallbackStats.size} bytes), likely a failed segment download`
                );
                reject(
                  new NetworkError(
                    `yt-dlp segment download failed: output file too small (${fallbackStats.size} bytes)`
                  )
                );
                return;
              }
              logger.info(
                `yt-dlp download complete (fallback): ${actualPath} (${fallbackStats.size} bytes)`
              );
              resolve(actualPath);
            } else {
              // No files in output directory after successful exit - video was likely filtered out
              // This happens when --match-filter skips the video (--quiet may suppress the message)
              if (maxDuration !== Infinity && startTime === null && duration === null) {
                reject(
                  new ValidationError('video duration exceeds the maximum allowed (3 minutes)')
                );
              } else {
                reject(new NetworkError('yt-dlp did not return output file path'));
              }
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
        } else if (
          errorOutput.includes('does not pass filter') ||
          errorOutput.includes('duration >')
        ) {
          reject(new ValidationError('video duration exceeds the maximum allowed (3 minutes)'));
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
 * Get video duration from YouTube using yt-dlp metadata fetch (fast, no download)
 * @param {string} url - YouTube URL to check
 * @param {number} timeout - Timeout in milliseconds (default: 15000 = 15 seconds)
 * @returns {Promise<number>} Video duration in seconds
 */
function getVideoDuration(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--no-warnings', '--print', 'duration', url];

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
      reject(new NetworkError('duration check timed out'));
    }, timeout);

    ytdlp.on('close', code => {
      clearTimeout(timeoutId);

      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
          reject(new NetworkError('could not parse video duration'));
        } else {
          resolve(duration);
        }
      } else {
        const errorOutput = stderr || stdout;
        if (errorOutput.includes('Video unavailable') || errorOutput.includes('Private video')) {
          reject(new NetworkError('video is unavailable or private'));
        } else if (errorOutput.includes('Sign in to confirm your age')) {
          reject(new NetworkError('video requires age verification'));
        } else {
          reject(
            new NetworkError(`failed to get video duration: ${errorOutput.substring(0, 100)}`)
          );
        }
      }
    });

    ytdlp.on('error', err => {
      clearTimeout(timeoutId);
      reject(new NetworkError(`duration check failed: ${err.message}`));
    });
  });
}

/**
 * Download video from YouTube using yt-dlp
 * @param {string} url - YouTube URL to download
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files and higher quality)
 * @param {number} maxSize - Maximum file size in bytes
 * @param {string} quality - Quality preference (default from config)
 * @param {number} maxDuration - Maximum video duration in seconds (default: 180 = 3 minutes, admins bypass this)
 * @param {number|null} startTime - Start time in seconds for segment download
 * @param {number|null} duration - Duration in seconds for segment download
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
export async function downloadFromYouTube(
  url,
  isAdminUser = false,
  maxSize = Infinity,
  quality = null,
  maxDuration = 180,
  startTime = null,
  duration = null
) {
  logger.info(
    `Downloading from YouTube: ${url} (admin: ${isAdminUser}, maxDuration: ${maxDuration}, startTime: ${startTime}, duration: ${duration})`
  );

  // Effective duration for segment download - will be calculated if only startTime is provided
  let effectiveDuration = duration;

  // Fast duration pre-check for non-admin users (skip if using segment download with explicit duration)
  // Also needed when only startTime is provided (to calculate duration to end of video)
  const needsDurationCheck =
    (maxDuration !== Infinity && startTime === null && duration === null) ||
    (startTime !== null && duration === null);

  if (needsDurationCheck) {
    try {
      const videoDuration = await getVideoDuration(url);
      logger.info(`Video duration: ${videoDuration}s (max: ${maxDuration}s)`);

      // Check duration limit (only when not using segment download)
      if (maxDuration !== Infinity && startTime === null && duration === null) {
        if (videoDuration > maxDuration) {
          const minutes = Math.floor(videoDuration / 60);
          const seconds = Math.round(videoDuration % 60);
          throw new ValidationError(
            `video is ${minutes}m ${seconds}s long, maximum allowed is ${Math.floor(maxDuration / 60)} minutes`
          );
        }
      }

      // Calculate effective duration when only startTime is provided (download from startTime to end)
      // yt-dlp's "*HH:MM:SS-inf" format doesn't work reliably, so we calculate the actual end time
      if (startTime !== null && duration === null) {
        effectiveDuration = videoDuration - startTime;
        logger.info(
          `Calculated effective duration: ${effectiveDuration}s (video: ${videoDuration}s - start: ${startTime}s)`
        );
      }
    } catch (error) {
      // If it's already a ValidationError (duration exceeded), re-throw it
      if (error instanceof ValidationError) {
        throw error;
      }
      // For other errors (network issues, etc.), log and continue with download
      // The download will fail with its own error if there's a real problem
      logger.warn(`Duration pre-check failed, proceeding with download: ${error.message}`);
    }
  }

  // Use appropriate quality based on user type
  // Admin users get best quality, regular users get 1080p max
  const effectiveQuality =
    quality ||
    (isAdminUser
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]');

  // Create temporary directory for download
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const useSegmentDownload = startTime !== null || effectiveDuration !== null;

  try {
    let outputPath;
    let usedFallback = false;

    if (useSegmentDownload) {
      // Try segment download first (using --download-sections)
      try {
        outputPath = await executeYtdlp(
          url,
          tmpDir.name,
          effectiveQuality,
          300000,
          maxDuration,
          startTime,
          effectiveDuration
        );
      } catch (segmentError) {
        // Check if this is a segment download failure (too small file)
        if (segmentError.message && segmentError.message.includes('output file too small')) {
          logger.warn(
            `Segment download failed, falling back to full download + FFmpeg trim: ${segmentError.message}`
          );
          usedFallback = true;

          // Download the full video without segment parameters
          outputPath = await executeYtdlp(
            url,
            tmpDir.name,
            effectiveQuality,
            300000,
            maxDuration,
            null,
            null
          );

          // Trim the video using FFmpeg
          const trimmedPath = path.join(tmpDir.name, 'trimmed_output.mp4');
          await trimVideo(outputPath, trimmedPath, { startTime, duration: effectiveDuration });

          // Use the trimmed file
          outputPath = trimmedPath;
          logger.info(`Fallback trim completed: ${outputPath}`);
        } else {
          // Re-throw other errors
          throw segmentError;
        }
      }
    } else {
      // No segment download requested, proceed normally
      outputPath = await executeYtdlp(
        url,
        tmpDir.name,
        effectiveQuality,
        300000,
        maxDuration,
        startTime,
        duration
      );
    }

    // Read the downloaded file
    const buffer = await fs.readFile(outputPath);

    // Check minimum file size - a valid video should be at least 1KB
    const MIN_VALID_VIDEO_SIZE = 1024;
    if (buffer.length < MIN_VALID_VIDEO_SIZE) {
      throw new NetworkError(
        `downloaded video is too small (${buffer.length} bytes), likely a failed download or corrupt file`
      );
    }

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
      `Successfully downloaded YouTube video${usedFallback ? ' (via fallback)' : ''}, size: ${buffer.length} bytes, content-type: ${contentType}, extension: ${ext}`
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
