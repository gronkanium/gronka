import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import tmp from 'tmp';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { trimVideo } from './video-processor/trim-video.js';
import { ytdlpSlots } from './concurrency.js';
import { DEFAULT_YTDLP_FORMAT } from './config.js';

const logger = createLogger('ytdlp');

// Appended to every duration/size-cap rejection so users know there's a way around it
// instead of just hitting a dead end.
const TRIM_TIP = ' use the start_time/end_time options to grab a clip under the limit.';

// Curated user-facing message for a video yt-dlp aborted (or we rejected) for exceeding the
// size cap. Raw byte counts stay in the logs; users just get the MB ceiling.
function tooLargeMessage(maxSize) {
  const mb = Math.floor(maxSize / (1024 * 1024));
  return `this video is too large to download (over ${mb}MB).` + TRIM_TIP;
}

// The generic yt-dlp failure bucket in executeYtdlp() below - kept as a constant so the
// retry wrapper can match on it without duplicating the string.
const GENERIC_FAILURE_MESSAGE =
  'could not download this content. it may be deleted, private, age-restricted, or unsupported.';

/**
 * Optional --cookies args for yt-dlp. Age-restricted content (notably TikTok, which Cobalt
 * has no cookie support for) needs a logged-in browser session, supplied as a Netscape
 * cookies.txt file via YTDLP_COOKIES_PATH. The file is domain-scoped, so passing it on
 * every invocation is safe - yt-dlp only sends cookies matching the target site.
 * Resolved at call time (not module load) so a file mounted/rotated later is picked up.
 * @returns {string[]} ['--cookies', path] when a usable file is configured, else []
 */
function getCookieArgs() {
  const cookiesPath = process.env.YTDLP_COOKIES_PATH;
  if (!cookiesPath) {
    return [];
  }
  try {
    // A missing host file makes Docker mount a directory in its place - isFile() guards that.
    if (fsSync.statSync(cookiesPath).isFile()) {
      return ['--cookies', cookiesPath];
    }
  } catch {
    // File not present; proceed without cookies.
  }
  return [];
}

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
 * Check if a URL is a RedGifs URL.
 * RedGifs is not a Cobalt service, but yt-dlp has a dedicated extractor for it
 * (watch/ifr pages resolve to media.redgifs.com mp4s), so these route through the
 * yt-dlp path like YouTube.
 * @param {string} url - URL to check
 * @returns {boolean} True if the URL is a RedGifs URL
 */
export function isRedGifsUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'redgifs.com' || hostname.endsWith('.redgifs.com');
  } catch {
    return false;
  }
}

// /p/ permalinks carry photos as often as video; /reel/ and /tv/ are always video.
function isInstagramPostUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return (
      (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) &&
      /^\/p\//.test(urlObj.pathname)
    );
  } catch {
    return false;
  }
}

// Sites that download through yt-dlp instead of Cobalt. Either Cobalt has no extractor
// for them (imgur, kick, coub, rumble, newgrounds, bilibili, the adult tube sites,
// redgifs) or we deliberately prefer yt-dlp (youtube). Each entry maps a display name to
// the hostnames it owns; matching is exact-or-subdomain on the www-stripped hostname.
// Order does not matter (hosts are disjoint). All were confirmed against the running
// yt-dlp build's extractor list.
export const YTDLP_SITES = [
  { name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { name: 'RedGifs', hosts: ['redgifs.com'] },
  { name: 'Imgur', hosts: ['imgur.com'] },
  { name: 'Kick', hosts: ['kick.com'] },
  { name: 'Coub', hosts: ['coub.com'] },
  { name: 'Rumble', hosts: ['rumble.com'] },
  { name: 'Newgrounds', hosts: ['newgrounds.com'] },
  { name: 'Bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  // Xiaohongshu / RedNote. `xhslink.com` is the app's share-link shortener. Pass these URLs
  // through untouched: the `xsec_token` query param on an /explore/ link is load-bearing, and
  // stripping it makes the same post fail to resolve.
  { name: 'Xiaohongshu', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { name: 'Pornhub', hosts: ['pornhub.com'] },
  { name: 'XVideos', hosts: ['xvideos.com'] },
  { name: 'xHamster', hosts: ['xhamster.com'] },
  { name: 'RedTube', hosts: ['redtube.com'] },
];

/**
 * Resolve the yt-dlp-handled site for a URL, if any.
 * @param {string} url - URL to classify
 * @returns {string|null} The site's display name (e.g. 'YouTube'), or null if no yt-dlp
 *   site owns this host.
 */
export function getYtdlpSite(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const site of YTDLP_SITES) {
      if (site.hosts.some(h => hostname === h || hostname.endsWith(`.${h}`))) {
        return site.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

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
 * @param {number} maxDuration - Maximum video duration in seconds (default: 300 = 5 minutes)
 * @param {number|null} startTime - Start time in seconds for segment download
 * @param {number|null} duration - Duration in seconds for segment download
 * @param {number} maxSize - Maximum file size in bytes; finite values add yt-dlp --max-filesize
 *   so oversized full downloads abort early instead of being caught after buffering (default: Infinity)
 * @returns {Promise<string>} Path to downloaded file
 */
function executeYtdlp(
  url,
  outputDir,
  quality,
  timeout = 300000,
  maxDuration = 300,
  startTime = null,
  duration = null,
  maxSize = Infinity
) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      ...getCookieArgs(),
      '-f',
      quality,
      '--merge-output-format',
      'mp4',
    ];

    if (maxDuration !== Infinity && startTime === null && duration === null) {
      // The `?` on the operator marks the field optional. Without it yt-dlp rejects any item
      // whose duration is unknown (`NA`) — which is every direct-media link handled by the
      // generic extractor, e.g. an animated webp from gif.fxtwitter.com. Those were skipped
      // silently (exit 0, no output) and then misreported as "duration exceeds the maximum".
      // Unknown-duration items stay bounded by --max-filesize and the post-read size check.
      args.push('--match-filter', `duration<=?${maxDuration}`);
    }

    // Abort oversized downloads before/while pulling instead of catching them after the whole
    // file is buffered in RAM. Only for full downloads: with --download-sections, yt-dlp
    // compares --max-filesize against the *entire* video's reported size, which would wrongly
    // abort a small requested clip. The post-read length check remains the definitive backstop
    // for sources whose size yt-dlp can't determine up front (e.g. some HLS streams).
    if (maxSize !== Infinity && startTime === null && duration === null) {
      const maxMb = Math.max(1, Math.floor(maxSize / (1024 * 1024)));
      args.push('--max-filesize', `${maxMb}M`);
    }

    // use yt-dlp's --download-sections to download ONLY the requested segment
    // this prevents downloading huge files when user only wants a small clip
    if (startTime !== null || duration !== null) {
      const start = startTime || 0;
      const end = duration !== null ? start + duration : 'inf';
      args.push('--download-sections', `*${start}-${end}`);
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
        const combinedOutput = stdout + stderr;

        // --max-filesize aborts print to stderr even under --quiet ("File is larger than
        // max-filesize ... Aborting"), so this loud path catches the size cap. The quiet
        // --match-filter duration skip is handled by the no-output fallback further down.
        if (/larger than max-filesize/i.test(combinedOutput)) {
          reject(new ValidationError(tooLargeMessage(maxSize)));
          return;
        }

        // yt-dlp exits with code 0 when --match-filter skips a video.
        // Only the duration filter may be blamed here: yt-dlp prints "Skipping" for plenty of
        // unrelated reasons (fragments, player responses, already-downloaded files), and
        // treating any of them as a length overage is how a user gets told a two-second gif
        // is longer than an hour.
        if (
          /does not pass filter \(duration/.test(combinedOutput) ||
          combinedOutput.includes('Video is longer than')
        ) {
          reject(
            new ValidationError(
              `video duration exceeds the maximum allowed (${Math.floor(maxDuration / 60)} minutes).` +
                TRIM_TIP
            )
          );
          return;
        }

        // yt-dlp prints the output file path via --print after_move:filepath
        // Filter out any progress messages and get only valid file paths
        const lines = stdout
          .trim()
          .split('\n')
          .map(line => line.trim())
          .filter(line => {
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
                reject(new NetworkError('yt-dlp segment download failed: output file too small'));
                return;
              }
              logger.info(`yt-dlp download complete: ${outputPath} (${stats.size} bytes)`);
              resolve(outputPath);
            } else {
              reject(new NetworkError('yt-dlp output path is not a file'));
            }
          } catch (statError) {
            const files = fsSync.readdirSync(outputDir);
            if (files.length > 0) {
              const actualPath = path.join(outputDir, files[0]);
              const fallbackStats = fsSync.statSync(actualPath);
              const MIN_VALID_VIDEO_SIZE = 1024;
              if (fallbackStats.size < MIN_VALID_VIDEO_SIZE) {
                logger.error(
                  `yt-dlp produced a suspiciously small file (${fallbackStats.size} bytes), likely a failed segment download`
                );
                reject(new NetworkError('yt-dlp segment download failed: output file too small'));
                return;
              }
              logger.info(
                `yt-dlp download complete (found file): ${actualPath} (${fallbackStats.size} bytes)`
              );
              resolve(actualPath);
            } else {
              logger.error(`yt-dlp output file not found at ${outputPath}: ${statError.message}`);
              reject(new NetworkError('the download failed. the content may be unavailable.'));
            }
          }
        } else {
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
                reject(new NetworkError('yt-dlp segment download failed: output file too small'));
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
                  new ValidationError(
                    `video duration exceeds the maximum allowed (${Math.floor(maxDuration / 60)} minutes).` +
                      TRIM_TIP
                  )
                );
              } else {
                reject(new NetworkError('yt-dlp did not return output file path'));
              }
            }
          } catch (readError) {
            logger.error(
              `yt-dlp did not return output file path and could not read output directory: ${readError.message}`
            );
            reject(new NetworkError('the download failed. the content may be unavailable.'));
          }
        }
      } else {
        const errorOutput = stderr || stdout;
        logger.error(`yt-dlp failed with code ${code}: ${errorOutput}`);

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
        } else if (errorOutput.includes('There is no video in this post')) {
          // Image-only posts (common on Instagram /p/ links). The post is perfectly fine —
          // there is simply no video for yt-dlp to take, so neither the generic "may be
          // deleted or private" message nor a formats-related one describes what happened.
          reject(new NetworkError('this post has no video in it.'));
        } else if (errorOutput.includes('No video formats found')) {
          // Instagram reports photo posts this way instead of the "There is no video in this
          // post" wording handled above, so a plain photo permalink reads to the user as a
          // bot failure. Every one of these seen in production was an instagram /p/ link.
          reject(
            new NetworkError(
              isInstagramPostUrl(url)
                ? 'this post has no video in it.'
                : 'no downloadable video formats found'
            )
          );
        } else if (/larger than max-filesize/i.test(errorOutput)) {
          reject(new ValidationError(tooLargeMessage(maxSize)));
        } else if (
          // Same care as the exit-0 path: only blame length when the duration filter is what
          // rejected the item, not on any filter message that happens to mention a skip.
          /does not pass filter \(duration/.test(errorOutput) ||
          errorOutput.includes('duration >')
        ) {
          reject(
            new ValidationError(
              `video duration exceeds the maximum allowed (${Math.floor(maxDuration / 60)} minutes).` +
                TRIM_TIP
            )
          );
        } else if (
          // X/Twitter: deleted or removed posts
          errorOutput.includes('BounceDeleted') ||
          /tweet (was )?(deleted|not found|unavailable)/i.test(errorOutput) ||
          errorOutput.includes('account is no longer available') ||
          /account .*(suspended|deactivated)/i.test(errorOutput)
        ) {
          reject(new NetworkError('this post is unavailable or has been deleted'));
        } else if (
          // X/Twitter: private, protected, or auth-gated posts
          errorOutput.includes('NSFW tweet requires authentication') ||
          errorOutput.includes('protected') ||
          errorOutput.includes('login required') ||
          errorOutput.includes('Requested content is not available')
        ) {
          reject(new NetworkError('this post is private and cannot be downloaded'));
        } else {
          // Never surface raw yt-dlp stderr to users; full output is logged above.
          reject(new NetworkError(GENERIC_FAILURE_MESSAGE));
        }
      }
    });

    ytdlp.on('error', err => {
      clearTimeout(timeoutId);
      if (err.code === 'ENOENT') {
        reject(new NetworkError('yt-dlp is not installed or not in PATH'));
      } else {
        logger.error(`yt-dlp process error: ${err.message}`);
        reject(new NetworkError('the download failed. please try again later.'));
      }
    });
  });
}

/**
 * Wraps executeYtdlp() with a single retry when it fails with the generic catch-all message.
 * That bucket covers anything yt-dlp didn't give us a specific reason for, which in practice
 * includes transient YouTube-side extraction hiccups that clear up seconds later - retrying
 * once recovers those silently instead of surfacing a false "unavailable" to the user. Every
 * other failure (rate limit, private/age-gated, invalid URL, duration cap) is a confirmed
 * state and retrying it immediately would just waste time, so only this bucket retries.
 */
async function executeYtdlpWithRetry(...args) {
  try {
    return await executeYtdlp(...args);
  } catch (error) {
    if (error.message !== GENERIC_FAILURE_MESSAGE) {
      throw error;
    }
    logger.warn(`yt-dlp generic failure, retrying once after a short delay: ${args[0]}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return await executeYtdlp(...args);
  }
}

function getVideoDuration(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--no-warnings', ...getCookieArgs(), '--print', 'duration', url];

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
 * @param {number} maxDuration - Maximum video duration in seconds (default: 300 = 5 minutes, admins bypass this)
 * @param {number|null} startTime - Start time in seconds for segment download
 * @param {number|null} duration - Duration in seconds for segment download
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
export async function downloadWithYtdlp(
  url,
  isAdminUser = false,
  maxSize = Infinity,
  quality = null,
  maxDuration = 300,
  startTime = null,
  duration = null
) {
  logger.info(
    `Downloading via yt-dlp: ${url} (admin: ${isAdminUser}, maxDuration: ${maxDuration}, startTime: ${startTime}, duration: ${duration})`
  );

  // Fast duration pre-check for non-admin users (skip if using segment download with explicit duration)
  // This prevents waiting for a full download attempt just to find out the video is too long
  const needsDurationCheck = maxDuration !== Infinity && startTime === null && duration === null;
  if (needsDurationCheck) {
    try {
      const videoDuration = await getVideoDuration(url);
      logger.info(`Video duration: ${videoDuration}s (max: ${maxDuration}s)`);

      if (videoDuration > maxDuration) {
        const minutes = Math.floor(videoDuration / 60);
        const seconds = Math.round(videoDuration % 60);
        throw new ValidationError(
          `video is ${minutes}m ${seconds}s long, maximum allowed is ${Math.floor(maxDuration / 60)} minutes.` +
            TRIM_TIP
        );
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      // For other errors (network issues, etc.), log and continue with download
      // The download will fail with its own error if there's a real problem
      logger.warn(`Duration pre-check failed, proceeding with download: ${error.message}`);
    }
  }

  // Admin users get best quality, regular users get 1080p max
  const effectiveQuality =
    quality ||
    (isAdminUser
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      : DEFAULT_YTDLP_FORMAT);

  // Admins are never size-gated; for everyone else the cap drives yt-dlp's --max-filesize.
  const gateSize = isAdminUser ? Infinity : maxSize;

  // Hold one of the limited yt-dlp slots for the memory-heavy download+read only. The cheap
  // metadata duration pre-check above runs unslotted so it never waits behind a big download.
  return await ytdlpSlots.run(async () => {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const useSegmentDownload = startTime !== null || duration !== null;

    try {
      let outputPath;
      let usedFallback = false;

      if (useSegmentDownload) {
        try {
          outputPath = await executeYtdlpWithRetry(
            url,
            tmpDir.name,
            effectiveQuality,
            300000,
            maxDuration,
            startTime,
            duration,
            gateSize
          );
        } catch (segmentError) {
          // Check if this is a segment download failure (too small file)
          if (segmentError.message && segmentError.message.includes('output file too small')) {
            logger.warn(
              `Segment download failed, falling back to full download + FFmpeg trim: ${segmentError.message}`
            );
            usedFallback = true;

            outputPath = await executeYtdlpWithRetry(
              url,
              tmpDir.name,
              effectiveQuality,
              300000,
              maxDuration,
              null,
              null,
              gateSize
            );

            const trimmedPath = path.join(tmpDir.name, 'trimmed_output.mp4');
            await trimVideo(outputPath, trimmedPath, { startTime, duration });

            outputPath = trimmedPath;
            logger.info(`Fallback trim completed: ${outputPath}`);
          } else {
            throw segmentError;
          }
        }
      } else {
        outputPath = await executeYtdlpWithRetry(
          url,
          tmpDir.name,
          effectiveQuality,
          300000,
          maxDuration,
          startTime,
          duration,
          gateSize
        );
      }

      const buffer = await fs.readFile(outputPath);

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
        `Successfully downloaded media via yt-dlp${usedFallback ? ' (via fallback)' : ''}, size: ${buffer.length} bytes, content-type: ${contentType}, extension: ${ext}`
      );

      return {
        buffer,
        contentType,
        size: buffer.length,
        filename, // Only used for extension extraction in download command, not user-facing
      };
    } catch (error) {
      logger.error(`yt-dlp download failed: ${error.message}`);
      throw error;
    } finally {
      try {
        tmpDir.removeCallback();
      } catch (cleanupError) {
        logger.warn(`Failed to clean up temp directory: ${cleanupError.message}`);
      }
    }
  });
}

/**
 * Download media from YouTube using yt-dlp.
 * This wrapper preserves the older function name for current callers.
 */
export async function downloadFromYouTube(
  url,
  isAdminUser = false,
  maxSize = Infinity,
  quality = null,
  maxDuration = 300,
  startTime = null,
  duration = null
) {
  return downloadWithYtdlp(url, isAdminUser, maxSize, quality, maxDuration, startTime, duration);
}

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
