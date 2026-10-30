import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger.js';
import {
  NetworkError,
  ValidationError,
  withCause,
  describeCause,
  contentGone,
  notPublishedYet,
  timedOut,
} from './errors.js';
import { trimVideo } from './video-processor/trim-video.js';
import { DEFAULT_YTDLP_FORMAT } from './config.js';
import { fromPath, tempDir, jobSignal, watchDirSize } from './media-file.js';
import { maxDownloadBytes, tooLarge } from './size-limit.js';
import { hostOf, normalizeHost, hostUnder } from './url-host.js';

const logger = createLogger('ytdlp');
const execFileAsync = promisify(execFile);
const SAVE_FAILURE_MESSAGE = 'the download finished but the file could not be saved, try again.';
const LIVE_MARK = 'gronka-live-status:';

// yt-dlp rewrites its jar after every run, so it gets a private copy and the mounted one stays read-only.
let jarCopy = null;
function privateJar(source, stats) {
  if (jarCopy?.mtimeMs !== stats.mtimeMs || jarCopy.source !== source) {
    const dir = jarCopy?.dir ?? fsSync.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-jar-'));
    const file = path.join(dir, 'cookies.txt');
    fsSync.copyFileSync(source, file);
    fsSync.chmodSync(file, 0o600);
    jarCopy = { dir, file, source, mtimeMs: stats.mtimeMs };
  }
  return jarCopy.file;
}

// Optional --cookies args for yt-dlp
export function getCookieArgs(url = null, signedIn = false) {
  // Signed-in YouTube gets ads, and yt-dlp waits ~5 s for each to be skippable: only sign in when asked.
  if (url && isYouTubeUrl(url) && !signedIn) return [];
  const cookiesPath = process.env.YTDLP_COOKIES_PATH;
  if (!cookiesPath) {
    return [];
  }
  try {
    // A missing host file makes Docker mount a directory in its place - isFile() guards that.
    const stats = fsSync.statSync(cookiesPath);
    if (stats.isFile()) {
      return ['--cookies', privateJar(cookiesPath, stats)];
    }
  } catch {
    // File not present; proceed without cookies.
  }
  return [];
}

/**
 * Custom error for yt-dlp rate limiting
 */
// yt-dlp's own ERROR line, else the last thing it said.
function ytdlpReason(output, code) {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const line = lines.findLast(l => l.startsWith('ERROR:')) ?? lines.at(-1);
  return line ? line.slice(0, 300) : `exit ${code} with no output`;
}

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
    const hostname = normalizeHost(urlObj.hostname);
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

// Signed-in requests get ads and a ~5 s wait, so web_embedded (needs bun + yt-dlp-ejs) is sign-in only.
export function getYouTubeArgs(url, signedIn = false) {
  if (!isYouTubeUrl(url)) return [];
  const clients = signedIn ? 'web_embedded,default' : 'default';
  return ['--js-runtimes', 'bun', '--extractor-args', `youtube:player_client=${clients}`];
}

// These reject yt-dlp's own TLS fingerprint (403, or Facebook's "Cannot parse data" once logged in); curl-cffi passes as Chrome.
const IMPERSONATE_HOSTS = ['rumble.com', 'pornhub.com', 'facebook.com', 'fb.watch', 'rule34.xxx'];
const hostIn = (url, hosts) => hostUnder(hostOf(url), hosts);

function isRedditManifest(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'v.redd.it' &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      /^\/[a-z0-9]+\/HLSPlaylist\.m3u8$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function getSiteArgs(url, viaGeoProxy = false) {
  const geoProxy = process.env.GEO_PROXY_URL;
  const site = YTDLP_SITES.find(s => hostIn(url, s.hosts));
  return [
    // Only Reddit's native manifests and Rule34Video (its own extractor finds no formats) need generic.
    '--ies',
    isRedditManifest(url)
      ? 'default'
      : hostIn(url, ['rule34video.com'])
        ? 'default,-rule34video'
        : 'default,-generic',
    ...(hostIn(url, IMPERSONATE_HOSTS) ? ['--impersonate', 'chrome'] : []),
    // One fragment at a time crawls through the tunnel (xHamster 223 KB/s vs 1.4 MB/s at 8).
    ...(geoProxy && (site?.geoBlocked || viaGeoProxy) ? ['--proxy', geoProxy, '-N', '8'] : []),
    ...(site?.args ?? []),
  ];
}

const siteLabel = url => getYtdlpSite(url) ?? hostOf(url) ?? 'this site';

// /p/ permalinks carry photos as often as video; /reel/ and /tv/ are always video.
function isInstagramPostUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = normalizeHost(urlObj.hostname);
    return hostUnder(hostname, 'instagram.com') && /^(?:\/[^/]+)?\/p\//.test(urlObj.pathname);
  } catch {
    return false;
  }
}

// Sites that download through yt-dlp instead of Cobalt. Either Cobalt has no extractor
// for them (imgur, kick, coub, rumble, niconico, bilibili, the adult tube sites,
// redgifs) or we deliberately prefer yt-dlp (youtube). Each entry maps a display name to
// the hostnames it owns; matching is exact-or-subdomain on the www-stripped hostname.
// Order does not matter (hosts are disjoint). All were confirmed against the running
// yt-dlp build's extractor list.
export const YTDLP_SITES = [
  { name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { name: 'RedGifs', hosts: ['redgifs.com'] },
  // Reddit-hosted video. The post page is unreadable (see reddit.js), but the CMAF streams the
  // HLS manifest points at are public, and yt-dlp muxes the separate video and audio itself.
  { name: 'Reddit', hosts: ['v.redd.it'] },
  { name: 'Imgur', hosts: ['imgur.com'] },
  { name: 'Kick', hosts: ['kick.com'] },
  { name: 'Coub', hosts: ['coub.com'] },
  { name: 'Rumble', hosts: ['rumble.com'] },
  // `nico.ms` is niconico's own shortener; yt-dlp resolves it to the /watch/ URL itself.
  { name: 'Niconico', hosts: ['nicovideo.jp', 'nico.ms'] },
  { name: 'Bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  // Xiaohongshu / RedNote. `xhslink.com` is the app's share-link shortener. Pass these URLs
  // through untouched: the `xsec_token` query param on an /explore/ link is load-bearing, and
  // stripping it makes the same post fail to resolve.
  { name: 'Xiaohongshu', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { name: 'Medal', hosts: ['medal.tv'] },
  { name: 'XVideos', hosts: ['xvideos.com'] },
  // Behind age-verification walls in some US states; they go through GEO_PROXY_URL when set.
  { name: 'Pornhub', hosts: ['pornhub.com'], geoBlocked: true },
  { name: 'xHamster', hosts: ['xhamster.com'], geoBlocked: true },
  // Its CDN answers 410 Gone to any request without the site as referer.
  {
    name: 'RedTube',
    hosts: ['redtube.com'],
    geoBlocked: true,
    args: ['--referer', 'https://www.redtube.com/'],
  },
  { name: 'Rule34Video', hosts: ['rule34video.com'] },
  { name: 'Bandcamp', hosts: ['bandcamp.com'] },
  { name: 'Internet Archive', hosts: ['archive.org'] },
];

export function getYtdlpSite(url) {
  try {
    const hostname = hostOf(url);
    for (const site of YTDLP_SITES) {
      if (hostUnder(hostname, site.hosts)) {
        return site.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function canonicalYtdlpUrl(url) {
  const shorty = /^https?:\/\/(?:[\w-]+\.)?pornhub\.com\/shorties\/(\w+)/i.exec(url);
  if (shorty) return `https://www.pornhub.com/view_video.php?viewkey=${shorty[1]}`;
  const spotlight = /^https?:\/\/(?:www\.)?snapchat\.com\/@[\w.-]+\/spotlight\/([\w-]+)/i.exec(url);
  return spotlight ? `https://www.snapchat.com/spotlight/${spotlight[1]}` : url;
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

const noVideo = () => new NetworkError('this post has no video in it.', 'NO_VIDEO');

const streamIsLive = () =>
  new ValidationError('this stream is still live, try again once it has ended.', 'STREAM_IS_LIVE');

// What a failed yt-dlp run said, in order: the first pattern that matches and returns an error wins.
const FAILURES = [
  [
    /HTTP Error 429|Too Many Requests/,
    url =>
      new YtdlpRateLimitError(
        `${siteLabel(url)} is rate limiting downloads right now, try again in a few minutes.`,
        5 * 60 * 1000
      ),
  ],
  [/Video unavailable|Private video/, () => contentGone()],
  [
    /Sign in to confirm your age/,
    () => new NetworkError('video requires age verification', 'AGE_RESTRICTED'),
  ],
  [
    /members-only|Join this channel to get access/i,
    () => new NetworkError('this video is members-only'),
  ],
  [
    /Sign in to confirm you['’]re not a bot|Please sign in/i,
    url =>
      new NetworkError(
        `${siteLabel(url)} is asking this server to sign in, this is usually temporary.`,
        'YTDLP_RETRYABLE'
      ),
  ],
  [
    /Unable to connect to proxy|ProxyError|proxy.*(refused|timed out)/i,
    url =>
      new NetworkError(
        `${siteLabel(url)} downloads go through a vpn that is not reachable right now, try again later.`
      ),
  ],
  [/Your IP address is blocked|status code 102\d\d/i, () => contentGone()],
  // TikTok US storage is missing some videos its global CDN still serves.
  [
    /unable to download video data: HTTP Error 404/,
    url =>
      hostIn(url, ['tiktok.com']) &&
      new NetworkError("tiktok isn't serving this video's file right now.", 'REGION_COPY_MISSING'),
  ],
  // Medal answers 403 until a fresh clip finishes publishing, usually within a minute.
  [/HTTP Error 403/, url => hostIn(url, ['medal.tv']) && notPublishedYet()],
  [/Unable to download webpage: HTTP Error (404|410)/, () => contentGone()],
  [
    /Cannot parse data/,
    url => new NetworkError(`${siteLabel(url)} changed its page and cannot be read yet.`),
  ],
  [
    /Unsupported URL|No suitable extractor found/,
    () =>
      new ValidationError('this link is not a downloadable video page.', 'YTDLP_UNSUPPORTED_URL'),
  ],
  [/is not a valid URL/, url => new ValidationError(`invalid ${siteLabel(url)} URL`)],
  [/There is no video in this post|No video could be found in this tweet/, noVideo],
  // Instagram reports photo posts this way too.
  [
    /No video formats found/,
    url =>
      isInstagramPostUrl(url) ? noVideo() : new NetworkError('no downloadable video formats found'),
  ],
  [/larger than max-filesize/i, (url, { maxSize }) => tooLarge(maxSize)],
  [
    /BounceDeleted|tweet (was )?(deleted|not found|unavailable)|account is no longer available|account .*(suspended|deactivated)/i,
    () => contentGone(),
  ],
  // Before the 'protected' check below, which is about protected X accounts.
  [
    /DRM protected/i,
    () =>
      new ValidationError(
        "the site only streams this one encrypted (drm), so it can't be downloaded.",
        'DRM_PROTECTED'
      ),
  ],
  [
    /NSFW tweet requires authentication|protected|login required|Requested content is not available/,
    () => new NetworkError('this post is private and cannot be downloaded'),
  ],
];

// Never surface raw yt-dlp stderr to users; the caller logs it in full.
export function classifyYtdlpFailure(output, url, limits = {}) {
  for (const [pattern, toError] of FAILURES) {
    const error = pattern.test(output) && toError(url, limits);
    if (error) return error;
  }
  return new NetworkError(`could not download this ${siteLabel(url)} link.`, 'YTDLP_UNKNOWN');
}

function executeYtdlp(
  url,
  outputDir,
  {
    quality,
    timeout = 300000,
    startTime = null,
    duration = null,
    maxSize,
    signedIn = false,
    viaGeoProxy = false,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      // The session cookies pin TikTok to its US CDN even through the proxy.
      ...(viaGeoProxy ? [] : getCookieArgs(url, signedIn)),
      ...getYouTubeArgs(url, signedIn),
      ...getSiteArgs(url, viaGeoProxy),
      '-f',
      quality,
      '--merge-output-format',
      'mp4',
      // A live stream would record until a limit cut it off. `!=?` lets sites with no live_status through.
      '--match-filter',
      '!is_live & live_status!=?is_upcoming',
      // The filter's skip is silent under --quiet; this prints before it, so the skip can be named.
      '--print',
      `pre_process:${LIVE_MARK}%(live_status)s`,
    ];

    // Abort oversized downloads before/while pulling instead of catching them after the whole
    // file is buffered in RAM. Only for full downloads: with --download-sections, yt-dlp
    // compares --max-filesize against the *entire* video's reported size, which would wrongly
    // abort a small requested clip. The post-read length check remains the definitive backstop
    // for sources whose size yt-dlp can't determine up front (e.g. some HLS streams).
    if (Number.isFinite(maxSize) && startTime === null && duration === null) {
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

    logger.debug(`Executing yt-dlp with args: ${args.join(' ')}`);

    const ytdlp = spawn('yt-dlp', args, {
      signal: jobSignal(),
      timeout,
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

    // --max-filesize can't bound section downloads or streams of unknown size; the disk can.
    // Twice the limit leaves room for the video and audio parts beside their merge.
    let overSize = false;
    const stopWatch = watchDirSize(outputDir, maxSize * 2, () => {
      overSize = true;
      ytdlp.kill('SIGKILL');
    });

    const timeoutId = setTimeout(() => {
      stopWatch();
      ytdlp.kill('SIGKILL');
      reject(timedOut(`yt-dlp: timed out after ${timeout / 1000}s`));
    }, timeout);

    ytdlp.on('close', code => {
      clearTimeout(timeoutId);
      stopWatch();
      const rejectWith = (error, detail) =>
        reject(withCause(error, `yt-dlp: ${detail ?? ytdlpReason(stderr || stdout, code)}`));

      if (overSize) {
        rejectWith(tooLarge(maxSize), `stopped at over ${maxSize * 2} bytes on disk`);
        return;
      }

      if (code === 0) {
        const combinedOutput = stdout + stderr;

        // --max-filesize aborts print to stderr even under --quiet ("File is larger than
        // max-filesize ... Aborting"), so this loud path catches the size cap.
        if (/larger than max-filesize/i.test(combinedOutput)) {
          rejectWith(tooLarge(maxSize));
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
                rejectWith(
                  new NetworkError('yt-dlp segment download failed: output file too small')
                );
                return;
              }
              logger.debug(`yt-dlp download complete: ${outputPath} (${stats.size} bytes)`);
              resolve(outputPath);
            } else {
              rejectWith(new NetworkError(SAVE_FAILURE_MESSAGE), 'output path is not a file');
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
                rejectWith(
                  new NetworkError('yt-dlp segment download failed: output file too small')
                );
                return;
              }
              logger.debug(
                `yt-dlp download complete (found file): ${actualPath} (${fallbackStats.size} bytes)`
              );
              resolve(actualPath);
            } else {
              logger.error(`yt-dlp output file not found at ${outputPath}: ${statError.message}`);
              rejectWith(
                new NetworkError(SAVE_FAILURE_MESSAGE),
                `exit 0 but no output file at ${outputPath}: ${statError.message}`
              );
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
                rejectWith(
                  new NetworkError('yt-dlp segment download failed: output file too small')
                );
                return;
              }
              logger.debug(
                `yt-dlp download complete (fallback): ${actualPath} (${fallbackStats.size} bytes)`
              );
              resolve(actualPath);
            } else if (new RegExp(`${LIVE_MARK}is_(live|upcoming)`).test(stdout)) {
              rejectWith(streamIsLive(), 'exit 0 with no file: the live stream filter skipped it');
            } else {
              // A post with no video (an Imgur photo album) is a playlist of zero items to yt-dlp.
              rejectWith(noVideo(), 'exit 0 with no file: yt-dlp found no video entries');
            }
          } catch (readError) {
            logger.error(
              `yt-dlp did not return output file path and could not read output directory: ${readError.message}`
            );
            rejectWith(
              new NetworkError(SAVE_FAILURE_MESSAGE),
              `exit 0 and the output dir is unreadable: ${readError.message}`
            );
          }
        }
      } else {
        const errorOutput = stderr || stdout;
        logger.error(`yt-dlp failed with code ${code}: ${errorOutput}`);

        rejectWith(classifyYtdlpFailure(errorOutput, url, { maxSize }));
      }
    });

    ytdlp.on('error', err => {
      clearTimeout(timeoutId);
      stopWatch();
      if (err.code === 'ENOENT') {
        reject(
          withCause(
            new NetworkError('video downloads are unavailable right now'),
            'yt-dlp: not installed or not on PATH'
          )
        );
      } else {
        logger.error(`yt-dlp process error: ${err.message}`);
        reject(
          withCause(
            new NetworkError('the download failed. please try again later.'),
            `yt-dlp: could not run: ${err.message}`
          )
        );
      }
    });
  });
}

/**
 * Wraps executeYtdlp() with a single retry when it fails with the generic catch-all message.
 * That bucket covers anything yt-dlp didn't give us a specific reason for, which in practice
 * includes transient YouTube-side extraction hiccups that clear up seconds later - retrying
 * once recovers those silently instead of surfacing a false "unavailable" to the user. Every
 * other failure (rate limit, private/age-gated, invalid URL, live stream) is a confirmed
 * state and retrying it immediately would just waste time, so only this bucket and the
 * failures tagged YTDLP_RETRYABLE retry.
 */
async function executeYtdlpWithRetry(url, outputDir, options) {
  try {
    return await executeYtdlp(url, outputDir, options);
  } catch (error) {
    if (isYouTubeUrl(url) && ['AGE_RESTRICTED', 'YTDLP_RETRYABLE'].includes(error.code)) {
      logger.debug(`YouTube asked to sign in, retrying signed in: ${url}`);
      return await executeYtdlp(url, outputDir, { ...options, signedIn: true });
    }
    // --download-sections crashes behind the proxy; the caller's full download + trim retries it.
    const trimming = options.startTime != null || options.duration != null;
    if (error.code === 'REGION_COPY_MISSING' && process.env.GEO_PROXY_URL && !trimming) {
      logger.warn(`No local copy of this video, retrying through the geo proxy: ${url}`);
      return await executeYtdlp(url, outputDir, { ...options, viaGeoProxy: true });
    }
    if (error.code !== 'YTDLP_UNKNOWN' && error.code !== 'YTDLP_RETRYABLE') {
      throw error;
    }
    logger.warn(`yt-dlp generic failure, retrying once after a short delay: ${url}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return await executeYtdlp(url, outputDir, options);
  }
}

// Resolved without cookies so no link we hand out is tied to our sessions, and http(s) only
// because a proxy can pass a file through but cannot stitch HLS/DASH fragments.
export async function getStreamInfo(rawUrl, timeout = 30000) {
  const url = canonicalYtdlpUrl(rawUrl);
  const args = [
    '-J',
    '--no-playlist',
    '--no-warnings',
    ...getYouTubeArgs(url),
    ...getSiteArgs(url),
    '-S',
    'res:1080,ext:mp4:m4a',
    '-f',
    'b[protocol^=http][vcodec!=none][acodec!=none]/bv*[protocol^=http]+ba[protocol^=http]/b*[protocol^=http]',
    url,
  ];
  const { stdout } = await execFileAsync('yt-dlp', args, {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    signal: jobSignal(),
  });
  const info = JSON.parse(stdout);
  const formats = info.requested_formats ?? [info];
  if (!formats.every(f => f.url && /^https?$/.test(f.protocol))) {
    return null;
  }
  return {
    title: info.title || 'video',
    ext: info.ext || 'mp4',
    parts: formats.map(f => ({
      url: f.url,
      headers: f.http_headers ?? {},
      ext: f.ext,
      kind:
        f.vcodec === 'none' || (!f.vcodec && f.acodec && f.acodec !== 'none' && !f.width)
          ? 'audio'
          : 'video',
    })),
  };
}

// Past the segment fallback, "output file too small" is a user-facing failure, not a control signal.
function emptyDownloadError(error) {
  if (error?.message?.includes('output file too small')) {
    throw withCause(
      new NetworkError('could not download this content, the link may not point to any media.'),
      error.cause ?? error
    );
  }
  throw error;
}

export async function downloadWithYtdlp(
  rawUrl,
  { maxSize, quality = null, startTime = null, duration = null } = {}
) {
  maxSize ??= await maxDownloadBytes();
  const url = canonicalYtdlpUrl(rawUrl);
  logger.debug(`Downloading via yt-dlp: ${url} (startTime: ${startTime}, duration: ${duration})`);

  const effectiveQuality = quality || DEFAULT_YTDLP_FORMAT;

  const workDir = await tempDir();
  const useSegmentDownload = startTime !== null || duration !== null;

  try {
    let outputPath;
    let usedFallback = false;

    const downloadThenTrim = async () => {
      usedFallback = true;
      const fullPath = await executeYtdlpWithRetry(url, workDir, {
        quality: effectiveQuality,
        maxSize,
      }).catch(emptyDownloadError);
      const trimmedPath = path.join(workDir, 'trimmed_output.mp4');
      await trimVideo(fullPath, trimmedPath, { startTime, duration });
      logger.debug(`Fallback trim completed: ${trimmedPath}`);
      return trimmedPath;
    };

    // --download-sections hands the fetch to ffmpeg, whose http proxy support crashes on these.
    if (useSegmentDownload && getSiteArgs(url).includes('--proxy')) {
      outputPath = await downloadThenTrim();
    } else if (useSegmentDownload) {
      try {
        outputPath = await executeYtdlpWithRetry(url, workDir, {
          quality: effectiveQuality,
          startTime,
          duration,
          maxSize,
        });
      } catch (segmentError) {
        if (
          !segmentError.message?.includes('output file too small') &&
          segmentError.code !== 'REGION_COPY_MISSING'
        ) {
          throw segmentError;
        }
        logger.warn(
          `Segment download failed, falling back to full download + FFmpeg trim: ${segmentError.message}`
        );
        outputPath = await downloadThenTrim();
      }
    } else {
      outputPath = await executeYtdlpWithRetry(url, workDir, {
        quality: effectiveQuality,
        startTime,
        duration,
        maxSize,
      }).catch(emptyDownloadError);
    }

    const filename = path.basename(outputPath);
    const contentType = getContentType(path.extname(outputPath));
    const file = await fromPath(outputPath, { contentType, filename });
    if (file.size > maxSize) throw tooLarge(maxSize, `yt-dlp: file is ${file.size} bytes`);
    logger.debug(
      `Successfully downloaded media via yt-dlp${usedFallback ? ' (via fallback)' : ''}, size: ${file.size} bytes, content-type: ${contentType}`
    );
    return { ...file, trimmed: useSegmentDownload };
  } catch (error) {
    logger.error(`yt-dlp download failed: ${describeCause(error.cause ?? error)}`);
    throw error;
  }
}
