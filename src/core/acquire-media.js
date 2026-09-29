import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import {
  isSoundCloudUrl,
  soundcloudViaYoutube,
  soundcloudTrack,
  tagAudio,
} from '../utils/soundcloud.js';
import {
  downloadFromSocialMedia,
  getCobaltMediaUrls,
  getRemoteContentLength,
} from '../utils/cobalt.js';
import { getYtdlpSite, downloadFromYouTube, downloadWithYtdlp } from '../utils/ytdlp.js';
import { getGalleryDlSite, downloadWithGalleryDl } from '../utils/gallery-dl.js';
import { isHentaiGifzUrl, downloadFromHentaiGifz } from '../utils/hentaigifz.js';
import { isBooruUrl, downloadFromBooru, booruCdnUserAgent } from '../utils/booru.js';
import { isPinterestUrl, downloadFromPinterest } from '../utils/pinterest.js';
import { isKlipyUrl, downloadFromKlipy } from '../utils/klipy.js';
import {
  isInstagramPostUrl,
  isInstagramStoryUrl,
  hasInstagramSession,
  downloadFromInstagram,
} from '../utils/instagram.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { ValidationError } from '../utils/errors.js';
import { BLOCKED_DESTINATION_MESSAGE, isPrivateHost } from '../utils/ssrf-guard.js';
import {
  isDirectMediaUrl,
  downloadDirectMedia,
  downloadFileFromUrl,
} from '../utils/file-downloader.js';
import { detectFileType } from '../utils/storage.js';
import { getBooleanSetting, getSetting } from '../utils/database.js';
import { isRedditPostUrl, hasRedditSession, resolveRedditPost } from '../utils/reddit.js';
import { convertToFormat } from '../utils/video-processor.js';
import { fitsDiscordAttachment } from '../commands/shared/attachment-limit.js';

const logger = createLogger('acquire-media');

// Reddit allows 20 images per gallery. Each slide is buffered whole in memory, so cap the fan-out
// rather than letting one link pull 20 full-resolution originals at once.
const MAX_REDDIT_GALLERY_SLIDES = 10;

function isTwitterXUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return (
      hostname === 'x.com' ||
      hostname === 'twitter.com' ||
      hostname === 'mobile.twitter.com' ||
      hostname.endsWith('.x.com') ||
      hostname.endsWith('.twitter.com')
    );
  } catch {
    return false;
  }
}

// TikTok URLs get the same Cobalt→yt-dlp fallback as X/Twitter: Cobalt has no TikTok cookie
// support, so age-restricted posts only work via yt-dlp with a cookies file (YTDLP_COOKIES_PATH).
function isTikTokUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

// A non-null label makes a Cobalt failure on this host eligible for the yt-dlp retry: Cobalt's
// extractors are flaky or auth-gated, and yt-dlp covers many of the same hosts.
function cobaltFallbackLabel(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'this platform';
  }
}

const {
  maxVideoSize: MAX_VIDEO_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  ytdlpQuality: YTDLP_QUALITY,
  galleryDlEnabled: GALLERY_DL_ENABLED,
} = botConfig;

// Size is the real gate (--max-filesize); this only caps pathological lengths.
async function getMaxVideoDuration() {
  const raw = await getSetting('max_video_duration', '3600');
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
}

async function getMaxVideoSize() {
  const mb = parseInt(await getSetting('max_video_size_mb', ''), 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : MAX_VIDEO_SIZE;
}

async function directMediaUrls(url, shouldServe = null) {
  const { urls, direct } = await getCobaltMediaUrls(COBALT_API_URL, url);
  if (!direct || urls.length === 0) {
    return null;
  }
  if (shouldServe && !(await shouldServe(urls))) {
    return null;
  }
  return urls;
}

// Discord-free half of /download: returns {kind: 'urls', urls, stepName} when a direct media URL
// should be handed out instead of a file, else {kind: 'file', fileData, downloadMethod, url}.
export async function acquireMedia(
  url,
  {
    adminUser = false,
    startTime = null,
    duration = null,
    galleryOptions = {},
    attachmentLimit = Infinity,
    client = null,
    logStep = () => {},
    urlOnly = null,
    streamFirst = null,
  } = {}
) {
  if (await isPrivateHost(url)) {
    throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
  }
  const maxSize = adminUser ? Infinity : await getMaxVideoSize();
  // Reddit deprecated the unauthenticated .json endpoints in May 2026, so yt-dlp cannot read
  // a post at all. Resolve it before the source flags below are computed: most posts are
  // link-aggregator entries whose media lives on redgifs/imgur, and swapping url for that
  // target lets the normal selection route it to the extractor that already handles it.
  let redditImages = null;
  if (isRedditPostUrl(url) && hasRedditSession()) {
    try {
      const resolved = await resolveRedditPost(url);
      if (resolved.external) {
        logger.info(`Reddit post points offsite, following to: ${resolved.external}`);
        // The disabled-source gate above ran on the reddit URL, so re-check the target:
        // following a hand-off must not smuggle past a source the owner turned off.
        const targetDisabled = await getDisabledServiceLabel(resolved.external);
        if (targetDisabled) {
          throw new ValidationError(`downloads from ${targetDisabled} are turned off.`);
        }
        if (await isPrivateHost(resolved.external)) {
          throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
        }
        url = resolved.external;
      } else {
        redditImages = resolved.images;
      }
    } catch (redditError) {
      // Falling back to cobalt is the net for a resolution failure, but it must not become a
      // way around the disabled-source gate two lines up, and a post reddit itself says is
      // gone has nothing for cobalt or yt-dlp to find either.
      if (redditError instanceof ValidationError || redditError.code === 'CONTENT_GONE') {
        throw redditError;
      }
      logger.warn(`Reddit resolution failed, falling back to cobalt: ${redditError.message}`);
    }
  }

  const ytdlpSite = getYtdlpSite(url);
  const galleryDlSite = getGalleryDlSite(url);
  const isHentaiGifz = isHentaiGifzUrl(url);
  const isBooru = isBooruUrl(url);
  const isPinterest = isPinterestUrl(url);
  const isKlipy = isKlipyUrl(url);
  const isDirectMedia = isDirectMediaUrl(url);
  // Cobalt tries Instagram's logged-out routes first; the session extractor is only the backstop.
  const useInstagram = isInstagramPostUrl(url) && hasInstagramSession();
  const isIgStory = isInstagramStoryUrl(url) && hasInstagramSession();
  const useReddit = redditImages !== null && redditImages.length > 0;
  // yt-dlp only does video, so a still image on a yt-dlp host (i.imgur.com/x.jpg) goes direct.
  const isStillImage = isDirectMedia && /\.(jpe?g|png|webp|bmp)$/i.test(new URL(url).pathname);
  const useYtdlp = ytdlpSite !== null && YTDLP_ENABLED && !isStillImage;

  // Trims need real bytes, and yt-dlp/gallery/booru/Pinterest sources have no cobalt URL.
  if (
    COBALT_ENABLED &&
    !useYtdlp &&
    !galleryDlSite &&
    !isHentaiGifz &&
    !isBooru &&
    !isPinterest &&
    !isKlipy &&
    !isIgStory &&
    !isDirectMedia &&
    startTime === null &&
    duration === null &&
    (urlOnly ?? (await getBooleanSetting('url_only_mode', false)))
  ) {
    logStep('url_only_mode', 'running', {
      message: 'URL-only mode enabled, fetching direct media URL from cobalt',
      metadata: { url },
    });
    try {
      const urls = await directMediaUrls(url);
      if (urls) {
        return { kind: 'urls', urls, stepName: 'url_only_mode', url };
      }
      logStep('url_only_mode', 'success', {
        message: 'No direct URL available (tunnel response), falling back to normal download',
        metadata: { url },
      });
    } catch (urlModeError) {
      logger.warn(`URL-only mode failed, falling back to download: ${urlModeError.message}`);
      logStep('url_only_mode', 'success', {
        message: 'URL-only mode failed, falling back to normal download',
        metadata: { url, reason: urlModeError.message },
      });
    }
  }

  // 'hybrid' still attaches small clips, which outlive the tweet; big ones get the twimg URL.
  if (COBALT_ENABLED && isTwitterXUrl(url) && startTime === null && duration === null) {
    const deliveryMode = await getSetting('twitter_delivery', 'hybrid');
    if (deliveryMode === 'always_url' || deliveryMode === 'hybrid') {
      try {
        const urls = await directMediaUrls(
          url,
          deliveryMode === 'always_url'
            ? null
            : async candidates => {
                if (candidates.length !== 1 || candidates[0].type !== 'video') {
                  return false;
                }
                const size = await getRemoteContentLength(candidates[0].url);
                return size !== null && !fitsDiscordAttachment(size, attachmentLimit);
              }
        );
        if (urls) {
          return { kind: 'urls', urls, stepName: 'twitter_delivery', url };
        }
      } catch (deliveryError) {
        logger.warn(
          `Twitter delivery policy (${deliveryMode}) failed, downloading instead: ${deliveryError.message}`
        );
        logStep('twitter_delivery', 'success', {
          message: 'Direct URL delivery failed, falling back to normal download',
          metadata: { url, deliveryMode, reason: deliveryError.message },
        });
      }
    }
  }

  let downloadMethod;
  if (useYtdlp) {
    downloadMethod = 'ytdlp';
    logger.info(`Downloading from ${ytdlpSite} via yt-dlp: ${url}`);
    logStep('download_start', 'running', {
      message: `Starting download from ${ytdlpSite} via yt-dlp`,
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (galleryDlSite && GALLERY_DL_ENABLED) {
    downloadMethod = 'gallery-dl';
    logger.info(`Downloading from ${galleryDlSite} via gallery-dl: ${url}`);
    logStep('download_start', 'running', {
      message: `Starting download from ${galleryDlSite} via gallery-dl`,
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isHentaiGifz) {
    downloadMethod = 'hentaigifz';
    logger.info(`Downloading from hentaigifz page scrape: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from hentaigifz',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isBooru) {
    downloadMethod = 'booru';
    logger.info(`Downloading from booru API: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from booru',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isPinterest) {
    downloadMethod = 'pinterest';
    logger.info(`Downloading from Pinterest page scrape: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from Pinterest',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isKlipy) {
    downloadMethod = 'klipy';
    logger.info(`Downloading from Klipy page scrape: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from Klipy',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isIgStory) {
    downloadMethod = 'instagram-story';
    logger.info(`Downloading Instagram story via web API: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from Instagram story',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (isDirectMedia) {
    downloadMethod = 'direct';
    logger.info(`Downloading direct media file: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting direct media download',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else if (useReddit) {
    downloadMethod = 'reddit';
    logger.info(`Downloading from Reddit post page: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from Reddit',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  } else {
    downloadMethod = 'cobalt';
    logger.info(`Downloading file from Cobalt: ${url}`);
    logStep('download_start', 'running', {
      message: 'Starting download from Cobalt',
      metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
    });
  }

  // Started early: it takes ~3 s and decides both the DRM route and the tags.
  const soundcloud =
    isSoundCloudUrl(url) && startTime === null && duration === null
      ? soundcloudTrack(url).catch(() => null)
      : null;

  // Runs beside the SoundCloud read; a DRM-only track has no source links to hand out.
  if (streamFirst && startTime === null && duration === null) {
    const lane = streamFirst(url, downloadMethod).catch(() => null);
    const streams = (await soundcloud)?.drm ? null : await lane;
    if (streams) {
      return { kind: 'stream', streams, url };
    }
  }

  let fileData;
  if (downloadMethod === 'ytdlp') {
    // --download-sections fetches only the trimmed segment, never the whole file.
    const skipDurationLimit = startTime !== null || duration !== null;
    const maxDuration = skipDurationLimit || adminUser ? Infinity : await getMaxVideoDuration();

    fileData = await downloadFromYouTube(
      url,
      adminUser,
      maxSize,
      adminUser ? null : YTDLP_QUALITY,
      maxDuration,
      startTime,
      duration
    );

    const trimmedByYtdlp = startTime !== null || duration !== null;
    logStep('download_complete', 'success', {
      message: trimmedByYtdlp
        ? 'file segment downloaded successfully via yt-dlp (already trimmed)'
        : 'file downloaded successfully via yt-dlp',
      metadata: {
        url,
        fileCount: 1,
        trimmedByYtdlp,
        startTime,
        duration,
      },
    });
  } else if (downloadMethod === 'gallery-dl') {
    fileData = await downloadWithGalleryDl(url, adminUser, maxSize, galleryOptions);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via gallery-dl',
      metadata: { url, fileCount: Array.isArray(fileData) ? fileData.length : 1 },
    });
  } else if (downloadMethod === 'hentaigifz') {
    fileData = await downloadFromHentaiGifz(url, adminUser);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via hentaigifz',
      metadata: { url, fileCount: 1 },
    });
  } else if (downloadMethod === 'booru') {
    fileData = await downloadFromBooru(url, adminUser);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via booru',
      metadata: { url, fileCount: 1 },
    });
  } else if (downloadMethod === 'pinterest') {
    fileData = await downloadFromPinterest(url, adminUser);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via Pinterest',
      metadata: { url, fileCount: 1 },
    });
  } else if (downloadMethod === 'klipy') {
    fileData = await downloadFromKlipy(url, adminUser);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via Klipy',
      metadata: { url, fileCount: 1 },
    });
  } else if (downloadMethod === 'instagram-story') {
    fileData = await downloadFromInstagram(url, adminUser);
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via Instagram story',
      metadata: { url, fileCount: Array.isArray(fileData) ? fileData.length : 1 },
    });
  } else if (downloadMethod === 'direct') {
    fileData = await downloadDirectMedia(url, adminUser, client, {
      userAgent: booruCdnUserAgent(url),
    });
    logStep('download_complete', 'success', {
      message: 'file downloaded successfully via direct fetch',
      metadata: { url, fileCount: 1 },
    });
  } else if (downloadMethod === 'reddit') {
    try {
      // Each slide carries candidates, best first: the unsigned original, then a signed
      // preview, because the original 404s for crossposts.
      let lastError;
      const downloadSlide = async candidates => {
        for (const candidate of candidates) {
          try {
            return await downloadFileFromUrl(candidate, adminUser);
          } catch (candidateError) {
            lastError = candidateError;
          }
        }
        return null;
      };

      const slides = redditImages.slice(0, MAX_REDDIT_GALLERY_SLIDES);
      const downloaded = (await Promise.all(slides.map(downloadSlide))).filter(Boolean);
      if (downloaded.length === 0) {
        throw lastError;
      }
      if (downloaded.length < slides.length) {
        logger.warn(
          `Reddit gallery: ${slides.length - downloaded.length} of ${slides.length} slide(s) failed, sending the rest`
        );
      }
      fileData = downloaded.length === 1 ? downloaded[0] : downloaded;
      logStep('download_complete', 'success', {
        message: 'file downloaded successfully via Reddit',
        metadata: { url, fileCount: 1 },
      });
    } catch (redditError) {
      logger.warn(`Reddit image fetch failed, falling back to cobalt: ${redditError.message}`);
      logStep('download_fallback', 'running', {
        message: 'Reddit image fetch failed, retrying with cobalt',
        metadata: { url, reason: redditError.message },
      });
      downloadMethod = 'cobalt';
    }
  }

  if (downloadMethod === 'cobalt') {
    try {
      // Concurrency is capped inside cobalt.js. The URL cache was already consulted
      // above (and deliberately skipped when trimming), so there is no second check here.
      fileData = await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize).catch(
        async cobaltError => {
          if (!useInstagram) throw cobaltError;
          logger.warn(`Cobalt failed for Instagram, trying the session: ${cobaltError.message}`);
          try {
            return await downloadFromInstagram(url, adminUser);
          } catch (instagramError) {
            logger.warn(`Instagram session extractor failed: ${instagramError.message}`);
            throw cobaltError;
          }
        }
      );
      logStep('download_complete', 'success', {
        message: 'File downloaded successfully',
        metadata: {
          url,
          fileCount: Array.isArray(fileData) ? fileData.length : 1,
        },
      });
    } catch (cobaltError) {
      const fallbackSite = isTwitterXUrl(url)
        ? 'X/Twitter'
        : isTikTokUrl(url)
          ? 'TikTok'
          : cobaltFallbackLabel(url);

      // X only: Discord plays a twimg URL in full, so the caps don't apply; others don't embed.
      const tryTwitterDirectUrl = async () => {
        if (!isTwitterXUrl(url) || startTime !== null || duration !== null) {
          return null;
        }
        if (!(await getBooleanSetting('twitter_direct_url_fallback', true))) {
          return null;
        }
        logStep('direct_url_fallback', 'running', {
          message: 'Download failed for X/Twitter URL, trying direct media URL',
          metadata: { url },
        });
        try {
          const urls = await directMediaUrls(url);
          if (urls) {
            return urls;
          }
          logStep('direct_url_fallback', 'success', {
            message: 'No direct URL available (tunnel response), surfacing download error',
            metadata: { url },
          });
        } catch (directUrlError) {
          logger.warn(`Direct URL fallback failed: ${directUrlError.message}`);
          logStep('direct_url_fallback', 'success', {
            message: 'Direct URL fallback failed, surfacing download error',
            metadata: { url, reason: directUrlError.message },
          });
        }
        return null;
      };

      if (!fallbackSite || !YTDLP_ENABLED) {
        const urls = await tryTwitterDirectUrl();
        if (urls) {
          return { kind: 'urls', urls, stepName: 'direct_url_fallback', url };
        }
        throw cobaltError;
      }

      const track = await soundcloud;
      if (track?.drm) {
        return {
          kind: 'file',
          fileData: await soundcloudViaYoutube(url, { adminUser, maxSize, track }),
          downloadMethod: 'ytdlp',
          url,
        };
      }

      logger.warn(
        `Cobalt failed for ${fallbackSite} URL, falling back to yt-dlp: ` + cobaltError.message
      );

      logStep('download_fallback', 'running', {
        message: `Cobalt failed for ${fallbackSite} URL, retrying with yt-dlp`,
        metadata: { url, reason: cobaltError.message },
      });

      const skipDurationLimit = startTime !== null || duration !== null;
      const maxDuration = skipDurationLimit || adminUser ? Infinity : await getMaxVideoDuration();

      try {
        fileData = await downloadWithYtdlp(
          url,
          adminUser,
          maxSize,
          adminUser ? null : YTDLP_QUALITY,
          maxDuration,
          startTime,
          duration
        );
      } catch (ytdlpFallbackError) {
        if (ytdlpFallbackError.code === 'DRM_PROTECTED' && isSoundCloudUrl(url)) {
          return {
            kind: 'file',
            fileData: await soundcloudViaYoutube(url, { adminUser, maxSize }),
            downloadMethod: 'ytdlp',
            url,
          };
        }
        const urls = await tryTwitterDirectUrl();
        if (urls) {
          return { kind: 'urls', urls, stepName: 'direct_url_fallback', url };
        }
        throw ytdlpFallbackError;
      }

      // yt-dlp already trimmed via --download-sections; mark the method so the
      // ffmpeg trim step below is skipped (otherwise it re-trims the segment).
      downloadMethod = 'ytdlp';

      logStep('download_fallback', 'success', {
        message: `yt-dlp fallback succeeded for ${fallbackSite} URL`,
        metadata: { url },
      });
      logStep('download_complete', 'success', {
        message: 'file downloaded successfully via yt-dlp fallback',
        metadata: {
          url,
          fileCount: 1,
          fallbackFrom: 'cobalt',
        },
      });
    }
  }

  const track = soundcloud && (await soundcloud);
  if (track && fileData?.buffer && !fileData.audioReady) {
    try {
      fileData = await tagAudio(fileData, track);
    } catch (error) {
      logger.warn(`SoundCloud tags skipped: ${error.message}`);
    }
  }

  return { kind: 'file', fileData, downloadMethod, url };
}

export async function extractAudio(
  fileData,
  downloadMethod,
  { startTime = null, duration = null } = {}
) {
  const source = Array.isArray(fileData)
    ? fileData.find(
        media =>
          detectFileType(
            path.extname(media.filename).toLowerCase(),
            media.contentType,
            media.buffer
          ) === 'video'
      )
    : fileData;
  if (!source?.buffer || fileData?.archive) {
    throw new ValidationError('there is no audio in that post to turn into an mp3.');
  }
  // Already a tagged mp3: re-encoding would drop the cover and tags for nothing.
  if (source.audioReady && startTime === null && duration === null) {
    return { buffer: source.buffer, baseName: path.parse(source.filename).name };
  }
  // yt-dlp (and its fallback) already cut the requested section.
  const trim = downloadMethod === 'ytdlp' ? {} : { startTime, duration };
  const buffer = await convertToFormat(
    source.buffer,
    path.extname(source.filename).toLowerCase() || '.mp4',
    'mp3',
    trim
  );
  const baseName = path.parse(source.filename).name.replace(/[^\w.-]+/g, '_') || 'audio';
  return { buffer, baseName };
}
