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
  getCobaltMediaUrls,
  getRemoteContentLength,
  canonicalizeMirrorUrl,
} from '../utils/cobalt.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { ValidationError, describeCause, rootCause, notPublishedYet } from '../utils/errors.js';
import { isFreshPost } from '../utils/post-age.js';
import { BLOCKED_DESTINATION_MESSAGE, isPrivateHost } from '../utils/ssrf-guard.js';
import { downloadFileFromUrl } from '../utils/file-downloader.js';
import { routeFor, routeById, chainFor } from './sources.js';
import { detectFileType } from '../utils/storage.js';
import { readSetting } from '../utils/settings.js';
import { isRedditPostUrl, hasRedditSession, resolveRedditPost } from '../utils/reddit.js';
import { convertToFormat } from '../utils/video-processor.js';
import { fitsDiscordAttachment } from '../commands/shared/attachment-limit.js';
import { youtubePostId, resolveYoutubePost } from '../utils/youtube-post.js';

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

const isTwitterXUrl = url => routeById('x').owns(url);

const { maxVideoSize: MAX_VIDEO_SIZE, cobaltApiUrl: COBALT_API_URL } = botConfig;

// A site extractor's gone or refused answer stops the chain; cobalt's never does (a TikTok US-CDN 404 reads as gone).
const GONE = ['CONTENT_GONE', 'CLIP_NOT_PUBLISHED'];
const worthAnotherSource = (engine, error) =>
  engine.id === 'cobalt' ||
  error.code === 'YTDLP_UNSUPPORTED_URL' ||
  (!(error instanceof ValidationError) && !GONE.includes(error.code));

// Size is the real gate (--max-filesize); this only caps pathological lengths.
const getMaxVideoDuration = () => readSetting('max_video_duration');

async function getMaxVideoSize() {
  const mb = await readSetting('max_video_size_mb');
  return mb > 0 ? mb * 1024 * 1024 : MAX_VIDEO_SIZE;
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
  url = canonicalizeMirrorUrl(url);
  if (await isPrivateHost(url)) {
    throw new ValidationError(BLOCKED_DESTINATION_MESSAGE);
  }
  const maxSize = await getMaxVideoSize();
  const trimming = startTime !== null || duration !== null;
  // Every extractor tried and why it failed, in order; the final error carries it for recordFailure.
  const trail = [];
  const note = (step, error) => trail.push({ step, error: describeCause(rootCause(error)) });
  const fail = error => Object.assign(error, { trail });
  // Reddit deprecated the unauthenticated .json endpoints in May 2026, so yt-dlp cannot read
  // a post at all. Resolve it before the source flags below are computed: most posts are
  // link-aggregator entries whose media lives on redgifs/imgur, and swapping url for that
  // target lets the normal selection route it to the extractor that already handles it.
  let redditImages = null;
  if (isRedditPostUrl(url) && hasRedditSession()) {
    try {
      const resolved = await resolveRedditPost(url);
      if (resolved.external && !routeFor(resolved.external)) {
        logger.debug(`Reddit post links to a site no source takes: ${resolved.external}`);
        redditImages = [];
      } else if (resolved.external) {
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
      note('reddit post', redditError);
      logger.warn(
        `Reddit resolution failed, falling back to cobalt: ${describeCause(rootCause(redditError))}`
      );
    }
  }

  // yt-dlp cannot read community posts: images get their own extractor, a linked video goes to yt-dlp.
  let postImages = null;
  const postId = youtubePostId(url);
  if (postId) {
    const post = await resolveYoutubePost(postId);
    if (post.videoId) url = `https://www.youtube.com/watch?v=${post.videoId}`;
    else postImages = post.images;
  }

  const ctx = {
    client,
    maxSize,
    startTime,
    duration,
    galleryOptions,
    cobaltResponse: null,
    maxDuration: async () => (trimming ? Infinity : await getMaxVideoDuration()),
  };
  const keep = response => (ctx.cobaltResponse = response);
  const local = postImages
    ? {
        id: 'youtube-post',
        name: 'YouTube post',
        extract: async () => {
          const files = await Promise.all(postImages.map(image => downloadFileFromUrl(image)));
          return files.length === 1 ? files[0] : files;
        },
      }
    : redditImages?.length > 0
      ? { id: 'reddit', name: 'Reddit', extract: () => downloadRedditSlides(redditImages) }
      : null;
  const { engines: routed, disabled } = await chainFor(url);
  if (!local && disabled) {
    throw new ValidationError(disabled.disabledMessage(url));
  }
  const engines = local ? [local, ...(postImages ? [] : routed)] : routed;
  if (!engines.length) {
    throw new ValidationError('url is not from a supported social media platform.');
  }
  const [first] = engines;

  // Trims need real bytes, and only cobalt has a cobalt URL to hand out.
  if (first.id === 'cobalt' && !trimming && (urlOnly ?? (await readSetting('url_only_mode')))) {
    try {
      const urls = await directMediaUrls(url, null, keep);
      if (urls) {
        return { kind: 'urls', urls, url };
      }
    } catch (urlModeError) {
      note('cobalt url-only', urlModeError);
      logger.warn(
        `URL-only mode failed, falling back to download: ${describeCause(rootCause(urlModeError))}`
      );
    }
  }

  // 'hybrid' still attaches small clips, which outlive the tweet; big ones get the twimg URL.
  if (first.id === 'cobalt' && !ctx.cobaltResponse && isTwitterXUrl(url) && !trimming) {
    const deliveryMode = await readSetting('twitter_delivery');
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
        note('cobalt twitter delivery', deliveryError);
        logger.warn(
          `Twitter delivery policy (${deliveryMode}) failed, downloading instead: ${describeCause(rootCause(deliveryError))}`
        );
      }
    }
  }

  logger.debug(`Downloading from ${engines.map(e => e.name).join(' > ')}: ${url}`);

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
  const cobaltGif = /\.gif$/i.test(ctx.cobaltResponse?.filename ?? '');
  if (streamFirst && first.streams && !cobaltGif && !trimming) {
    const lane = streamFirst(url, first.id).catch(error => {
      logger.debug(`Stream lane unavailable, using the download path: ${error.message}`);
      return null;
    });
    const streams = (await soundcloud)?.drm ? null : await lane;
    if (streams) {
      return { kind: 'stream', streams, url };
    }
  }

  const viaYoutube = async track => ({
    kind: 'file',
    fileData: await soundcloudViaYoutube(url, { maxSize, track }),
    downloadMethod: 'ytdlp',
    url,
  });
  let fileData;
  let method = null;
  let lastError = null;
  let gone = false;
  for (const [index, engine] of engines.entries()) {
    if (lastError) {
      // A DRM-only SoundCloud track has nothing for the next engine; its YouTube copy does.
      const track = await soundcloud;
      if (track?.drm) return viaYoutube(track);
      logger.warn(
        `${engines[index - 1].name} failed, trying ${engine.name}: ${describeCause(rootCause(lastError))}`
      );
    }
    try {
      fileData = await engine.extract(url, ctx);
      method = engine.id;
      break;
    } catch (error) {
      note(engine.name.toLowerCase(), error);
      lastError = error;
      gone ||= GONE.includes(error.code);
      if (error.code === 'DRM_PROTECTED' && isSoundCloudUrl(url)) return viaYoutube();
      if (!worthAnotherSource(engine, error)) break;
    }
  }

  if (!method) {
    // X only: Discord plays a twimg URL in full, so the caps don't apply; others don't embed.
    if (
      isTwitterXUrl(url) &&
      !trimming &&
      !gone &&
      (await readSetting('twitter_direct_url_fallback'))
    ) {
      try {
        const urls = await directMediaUrls(url);
        if (urls) return { kind: 'urls', urls, url };
      } catch (directUrlError) {
        note('cobalt direct url', directUrlError);
        logger.warn(`Direct URL fallback failed: ${describeCause(rootCause(directUrlError))}`);
      }
    }
    const fresh = gone && isFreshPost(url, Date.now(), describeCause(rootCause(lastError)));
    throw fail(fresh ? notPublishedYet(lastError) : lastError);
  }

  const track = soundcloud && (await soundcloud);
  if (track && fileData?.path && !fileData.audioReady) {
    try {
      fileData = await tagAudio(fileData, track);
    } catch (error) {
      logger.warn(`SoundCloud tags skipped: ${error.message}`);
    }
  }

  return { kind: 'file', fileData, downloadMethod: method, url };
}

export async function extractAudio(fileData, { startTime = null, duration = null } = {}) {
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
  const trim = source.trimmed ? {} : { startTime, duration };
  const file = await convertToFormat(source, 'mp3', trim);
  const baseName = path.parse(source.filename).name.replace(/[^\w.-]+/g, '_') || 'audio';
  return { file, baseName };
}
