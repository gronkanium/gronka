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
import { getYtdlpSite, downloadWithYtdlp } from '../utils/ytdlp.js';
import { getGalleryDlSite, downloadWithGalleryDl } from '../utils/gallery-dl.js';
import { isHentaiGifzUrl, downloadFromHentaiGifz } from '../utils/hentaigifz.js';
import { isBooruUrl, downloadFromBooru, booruCdnUserAgent } from '../utils/booru.js';
import { isPinterestUrl, downloadFromPinterest } from '../utils/pinterest.js';
import { isKlipyUrl, downloadFromKlipy } from '../utils/klipy.js';
import { isThreadsUrl, downloadFromThreads } from '../utils/threads.js';
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
import { hostOf } from '../utils/url-host.js';

const logger = createLogger('acquire-media');

// Reddit allows 20 images per gallery; one link should not pull 20 full-resolution originals.
const MAX_REDDIT_GALLERY_SLIDES = 10;

// Each slide carries candidates, best first: the unsigned original, then a signed preview,
// because the original 404s for crossposts.
async function downloadRedditSlides(images) {
  let lastError;
  const downloadSlide = async candidates => {
    for (const candidate of candidates) {
      try {
        return await downloadFileFromUrl(candidate);
      } catch (candidateError) {
        lastError = candidateError;
      }
    }
    return null;
  };
  const slides = images.slice(0, MAX_REDDIT_GALLERY_SLIDES);
  const downloaded = (await Promise.all(slides.map(downloadSlide))).filter(Boolean);
  if (downloaded.length === 0) {
    throw lastError;
  }
  if (downloaded.length < slides.length) {
    logger.warn(
      `Reddit gallery: ${slides.length - downloaded.length} of ${slides.length} slide(s) failed, sending the rest`
    );
  }
  return downloaded.length === 1 ? downloaded[0] : downloaded;
}

function isTwitterXUrl(url) {
  try {
    const hostname = hostOf(url);
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
    const hostname = hostOf(url);
    return hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

// A non-null label makes a Cobalt failure on this host eligible for the yt-dlp retry: Cobalt's
// extractors are flaky or auth-gated, and yt-dlp covers many of the same hosts.
const cobaltFallbackLabel = url => hostOf(url) ?? 'this platform';

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

async function directMediaUrls(url, shouldServe = null, keep = () => {}) {
  const { urls, direct, response } = await getCobaltMediaUrls(COBALT_API_URL, url);
  keep(response);
  if (!direct || urls.length === 0) {
    return null;
  }
  if (shouldServe && !(await shouldServe(urls))) {
    return null;
  }
  return urls;
}

// Discord-free half of /download: returns {kind: 'urls', urls} when a direct media URL
// should be handed out instead of a file, else {kind: 'file', fileData, downloadMethod, url}.
export async function acquireMedia(
  url,
  {
    startTime = null,
    duration = null,
    galleryOptions = {},
    attachmentLimit = Infinity,
    client = null,
    urlOnly = null,
    streamFirst = null,
  } = {}
) {
  if (await isPrivateHost(url)) {
    throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
  }
  const maxSize = await getMaxVideoSize();
  const trimming = startTime !== null || duration !== null;
  let cobaltResponse = null;
  const keep = response => (cobaltResponse = response);
  // Reddit deprecated the unauthenticated .json endpoints in May 2026, so yt-dlp cannot read
  // a post at all. Resolve it before the source flags below are computed: most posts are
  // link-aggregator entries whose media lives on redgifs/imgur, and swapping url for that
  // target lets the normal selection route it to the extractor that already handles it.
  let redditImages = null;
  if (isRedditPostUrl(url) && hasRedditSession()) {
    try {
      const resolved = await resolveRedditPost(url);
      if (resolved.external) {
        logger.debug(`Reddit post points offsite, following to: ${resolved.external}`);
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
  const isThreads = isThreadsUrl(url);
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
    !isThreads &&
    !isIgStory &&
    !isDirectMedia &&
    !trimming &&
    (urlOnly ?? (await getBooleanSetting('url_only_mode', false)))
  ) {
    try {
      const urls = await directMediaUrls(url, null, keep);
      if (urls) {
        return { kind: 'urls', urls, url };
      }
    } catch (urlModeError) {
      logger.warn(`URL-only mode failed, falling back to download: ${urlModeError.message}`);
    }
  }

  // 'hybrid' still attaches small clips, which outlive the tweet; big ones get the twimg URL.
  if (COBALT_ENABLED && !cobaltResponse && isTwitterXUrl(url) && !trimming) {
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
              },
          keep
        );
        if (urls) {
          return { kind: 'urls', urls, url };
        }
      } catch (deliveryError) {
        logger.warn(
          `Twitter delivery policy (${deliveryMode}) failed, downloading instead: ${deliveryError.message}`
        );
      }
    }
  }

  const ytdlpMaxDuration = async () => (trimming ? Infinity : await getMaxVideoDuration());
  const extractors = [
    [
      'ytdlp',
      useYtdlp,
      `${ytdlpSite} via yt-dlp`,
      async () =>
        downloadWithYtdlp(
          url,
          maxSize,
          YTDLP_QUALITY,
          await ytdlpMaxDuration(),
          startTime,
          duration
        ),
    ],
    [
      'gallery-dl',
      galleryDlSite && GALLERY_DL_ENABLED,
      `${galleryDlSite} via gallery-dl`,
      () => downloadWithGalleryDl(url, maxSize, galleryOptions),
    ],
    ['hentaigifz', isHentaiGifz, 'hentaigifz', () => downloadFromHentaiGifz(url)],
    ['booru', isBooru, 'booru', () => downloadFromBooru(url)],
    ['pinterest', isPinterest, 'Pinterest', () => downloadFromPinterest(url)],
    ['klipy', isKlipy, 'Klipy', () => downloadFromKlipy(url)],
    ['threads', isThreads, 'Threads', () => downloadFromThreads(url)],
    ['instagram-story', isIgStory, 'Instagram story', () => downloadFromInstagram(url)],
    [
      'direct',
      isDirectMedia,
      'direct media link',
      () => downloadDirectMedia(url, client, { userAgent: booruCdnUserAgent(url) }),
    ],
    ['reddit', useReddit, 'Reddit', () => downloadRedditSlides(redditImages)],
  ];
  let [downloadMethod, , sourceLabel, extract] = extractors.find(([, applies]) => applies) ?? [
    'cobalt',
    true,
    'Cobalt',
    null,
  ];
  logger.debug(`Downloading from ${sourceLabel}: ${url}`);

  // Started early: it takes ~3 s and decides both the DRM route and the tags.
  const soundcloud =
    isSoundCloudUrl(url) && !trimming
      ? soundcloudTrack(url).catch(error => {
          logger.warn(`SoundCloud track read failed: ${error.message}`);
          return null;
        })
      : null;

  // Runs beside the SoundCloud read; a DRM-only track has no source links to hand out.
  // cobalt turns X's looping mp4s into real gifs; a raw stream would hand out the mp4.
  const cobaltGif = /\.gif$/i.test(cobaltResponse?.filename ?? '');
  if (streamFirst && !cobaltGif && !trimming) {
    const lane = streamFirst(url, downloadMethod).catch(error => {
      logger.debug(`Stream lane unavailable, using the download path: ${error.message}`);
      return null;
    });
    const streams = (await soundcloud)?.drm ? null : await lane;
    if (streams) {
      return { kind: 'stream', streams, url };
    }
  }

  let fileData;
  if (extract) {
    try {
      fileData = await extract();
    } catch (extractError) {
      if (downloadMethod !== 'reddit') throw extractError;
      logger.warn(`Reddit image fetch failed, falling back to cobalt: ${extractError.message}`);
      downloadMethod = 'cobalt';
    }
  }

  if (downloadMethod === 'cobalt') {
    try {
      // Concurrency is capped inside cobalt.js. The URL cache was already consulted
      // above (and deliberately skipped when trimming), so there is no second check here.
      fileData = await downloadFromSocialMedia(COBALT_API_URL, url, maxSize, cobaltResponse).catch(
        async cobaltError => {
          if (!useInstagram) throw cobaltError;
          logger.warn(`Cobalt failed for Instagram, trying the session: ${cobaltError.message}`);
          try {
            return await downloadFromInstagram(url);
          } catch (instagramError) {
            logger.warn(`Instagram session extractor failed: ${instagramError.message}`);
            throw cobaltError;
          }
        }
      );
    } catch (cobaltError) {
      const fallbackSite = isTwitterXUrl(url)
        ? 'X/Twitter'
        : isTikTokUrl(url)
          ? 'TikTok'
          : cobaltFallbackLabel(url);

      // X only: Discord plays a twimg URL in full, so the caps don't apply; others don't embed.
      const tryTwitterDirectUrl = async () => {
        if (!isTwitterXUrl(url) || trimming) {
          return null;
        }
        if (!(await getBooleanSetting('twitter_direct_url_fallback', true))) {
          return null;
        }
        try {
          const urls = await directMediaUrls(url);
          if (urls) {
            return urls;
          }
        } catch (directUrlError) {
          logger.warn(`Direct URL fallback failed: ${directUrlError.message}`);
        }
        return null;
      };

      if (!fallbackSite || !YTDLP_ENABLED) {
        const urls = await tryTwitterDirectUrl();
        if (urls) {
          return { kind: 'urls', urls, url };
        }
        throw cobaltError;
      }

      const track = await soundcloud;
      if (track?.drm) {
        return {
          kind: 'file',
          fileData: await soundcloudViaYoutube(url, { maxSize, track }),
          downloadMethod: 'ytdlp',
          url,
        };
      }

      logger.warn(
        `Cobalt failed for ${fallbackSite} URL, falling back to yt-dlp: ` + cobaltError.message
      );

      try {
        fileData = await downloadWithYtdlp(
          url,
          maxSize,
          YTDLP_QUALITY,
          await ytdlpMaxDuration(),
          startTime,
          duration
        );
      } catch (ytdlpFallbackError) {
        if (ytdlpFallbackError.code === 'DRM_PROTECTED' && isSoundCloudUrl(url)) {
          return {
            kind: 'file',
            fileData: await soundcloudViaYoutube(url, { maxSize }),
            downloadMethod: 'ytdlp',
            url,
          };
        }
        const urls = await tryTwitterDirectUrl();
        if (urls) {
          return { kind: 'urls', urls, url };
        }
        throw ytdlpFallbackError;
      }

      // yt-dlp already trimmed via --download-sections; mark the method so the
      // ffmpeg trim step below is skipped (otherwise it re-trims the segment).
      downloadMethod = 'ytdlp';
    }
  }

  const track = soundcloud && (await soundcloud);
  if (track && fileData?.path && !fileData.audioReady) {
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
            media.head
          ) === 'video'
      )
    : fileData;
  if (!source?.path || fileData?.archive) {
    throw new ValidationError('there is no audio in that post to turn into an mp3.');
  }
  // Already a tagged mp3: re-encoding would drop the cover and tags for nothing.
  if (source.audioReady && startTime === null && duration === null) {
    return { file: source, baseName: path.parse(source.filename).name };
  }
  // yt-dlp (and its fallback) already cut the requested section.
  const trim = downloadMethod === 'ytdlp' ? {} : { startTime, duration };
  const file = await convertToFormat(source, 'mp3', trim);
  const baseName = path.parse(source.filename).name.replace(/[^\w.-]+/g, '_') || 'audio';
  return { file, baseName };
}
