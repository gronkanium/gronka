import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { fetchToFile, withExtension } from './media-file.js';
import { detectFileType } from './storage.js';
import { mapLimit, ITEM_FANOUT } from './map-limit.js';
import { normalizeHost } from './url-host.js';

const logger = createLogger('cobalt');

// How many items of a single picker/carousel response download at once. Bounds the memory a
// single multi-file post can hold; picker items are usually photos, so this stays generous
// enough not to slow normal carousels down.

const CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Cobalt's tunnel sends no content-type header at all, so defaulting to video/mp4 relabelled
// every real GIF (x.com animated GIFs arrive as GIF89a) and /convert then rejected them as
// "not a valid video format". Magic bytes are the only honest signal when the header is absent.
export function resolveContentType(headerType, filename, head) {
  if (headerType) {
    return headerType;
  }
  const ext = (filename.toLowerCase().match(/\.[^.]+$/) || [''])[0];
  const kind = detectFileType(ext, '', head);
  if (kind === 'gif') {
    return 'image/gif';
  }
  if (kind === 'image') {
    return { '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  }
  return { '.mov': 'video/quicktime', '.webm': 'video/webm' }[ext] || 'video/mp4';
}

export function normalizeFilenameForContentType(filename, contentType) {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase().split(';', 1)[0].trim()];
  if (!extension) {
    return filename;
  }

  return /\.[^.]+$/.test(filename)
    ? filename.replace(/\.[^.]+$/, extension)
    : `${filename}${extension}`;
}

/**
 * Map of Cobalt API error codes to user-friendly messages
 */
const COBALT_ERROR_MESSAGES = {
  // Content errors
  'error.api.content.post.unavailable': 'this post is unavailable or has been deleted',
  'error.api.content.post.age': 'this post is age-restricted and cannot be downloaded',
  'error.api.content.video.unavailable': 'this video is unavailable or has been deleted',
  'error.api.content.too_large': 'this content is too large to download',

  // Fetch errors
  'error.api.fetch.empty': 'unable to fetch content (it may be deleted, private, or rate-limited)',
  'error.api.fetch.fail': 'failed to fetch content from the platform',
  'error.api.fetch.rate': 'rate limited by the platform, please try again later',

  // Link/Service errors
  'error.api.link.invalid': 'invalid or unsupported url format',
  'error.api.link.unsupported': 'this service is not supported', // Will be customized with service name

  // Generic errors
  'error.api.generic': 'an error occurred while processing your request',
  'error.api.auth.jwt.missing': 'authentication required',
  'error.api.auth.jwt.invalid': 'invalid authentication token',
};

function getCobaltErrorMessage(errorCode, context = {}) {
  if (!errorCode) {
    return null;
  }

  if (errorCode === 'error.api.link.unsupported' && context?.service) {
    return `the service "${context.service}" is not supported by cobalt`;
  }

  return COBALT_ERROR_MESSAGES[errorCode] || null;
}

// Classify a Cobalt API error response
function analyzeError(data, errorObj) {
  const result = {
    isRateLimit: false,
    isNotFound: false,
    userMessage: null,
    errorCode: null,
    context: null,
  };

  // Extract error code from response (can be in data.code or data.error.code)
  const errorCode = data?.code || data?.error?.code;
  const errorContext = data?.context || data?.error?.context;

  if (errorCode) {
    result.errorCode = errorCode;
    result.context = errorContext;

    const friendlyMessage = getCobaltErrorMessage(errorCode, errorContext);
    if (friendlyMessage) {
      result.userMessage = friendlyMessage;
    }
  }

  if (errorCode && errorCode.includes('rate')) {
    result.isRateLimit = true;
    return result;
  }

  // Check HTTP status code (429 is definitive rate limit)
  if (errorObj?.response?.status === 429) {
    result.isRateLimit = true;
    return result;
  }

  switch (errorCode) {
    case 'error.api.content.post.unavailable':
    case 'error.api.content.video.unavailable':
      result.isNotFound = true;
      return result;

    case 'error.api.content.post.age':
      result.isNotFound = true; // Don't retry age-restricted content
      return result;

    case 'error.api.link.invalid':
    case 'error.api.link.unsupported':
      result.isNotFound = true; // Don't retry invalid/unsupported URLs
      return result;

    case 'error.api.fetch.rate':
      result.isRateLimit = true;
      return result;

    case 'error.api.fetch.fail':
      // Fetch failures could be temporary, but don't classify as rate limit
      return result;
  }

  // error.api.fetch.empty is ambiguous: treat as "not found" when the response
  // text says so, otherwise as a plain failure (never guess it's a rate limit).
  if (errorCode === 'error.api.fetch.empty') {
    const errorText = (data?.error?.text || data?.text || '').toLowerCase();
    if (
      errorText.includes('not found') ||
      errorText.includes("doesn't exist") ||
      errorText.includes('unavailable') ||
      errorText.includes('deleted')
    ) {
      result.isNotFound = true;
    }
    return result;
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// X/Twitter status-URL tracking params and host aliases used for normalization
const X_STATUS_TRACKING_PARAMS = ['s', 't', 'src'];
const X_HOST_ALIASES = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

// Embed-fixer mirror domains people paste instead of x.com, mapped to the canonical host Cobalt understands. Cobalt doesn't
// know these hosts, so they must always be rewritten before the API call.
const EMBED_FIXER_HOSTS = new Map([
  ['fxtwitter.com', 'twitter.com'],
  ['fixupx.com', 'twitter.com'],
  ['twittpr.com', 'twitter.com'],
  ['pxtwitter.com', 'twitter.com'],
  // BetterTwitFix (vxtwitter)
  ['vxtwitter.com', 'twitter.com'],
  ['fixvx.com', 'twitter.com'],
  // Community instances
  ['cunnyx.com', 'twitter.com'],
  ['girlcockx.com', 'twitter.com'],
  ['stupidpenisx.com', 'twitter.com'],
  ['chudx.com', 'twitter.com'],
  // Embed mirrors for Bluesky
  ['fxbsky.app', 'bsky.app'],
  ['bskx.app', 'bsky.app'],
  // ddinstagram.com omitted: no longer resolves.
  ['kkinstagram.com', 'instagram.com'],
  ['eeinstagram.com', 'instagram.com'],
  ['vxinstagram.com', 'instagram.com'],
  ['zzinstagram.com', 'instagram.com'],
  ['uuinstagram.com', 'instagram.com'],
  ['rxddit.com', 'reddit.com'],
  ['vxreddit.com', 'reddit.com'],
  ['tnktok.com', 'tiktok.com'],
  ['tfxktok.com', 'tiktok.com'],
  ['vxtiktok.com', 'tiktok.com'],
]);

const GIPHY_PAGE_PATH = /^\/(?:gifs|stickers|embed)\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/;

// Canonicalize before routing: the Instagram extractor matches canonical hosts only.
export function canonicalizeMirrorUrl(url) {
  try {
    const urlObj = new URL(url);
    // A giphy page's id maps straight to its gif, so it routes as a direct media link.
    const giphyId = /^(www\.)?giphy\.com$/i.test(urlObj.hostname)
      ? urlObj.pathname.match(GIPHY_PAGE_PATH)?.[1]
      : null;
    if (giphyId) {
      return `https://i.giphy.com/${giphyId}.gif`;
    }
    const canonicalHost = EMBED_FIXER_HOSTS.get(normalizeHost(urlObj.hostname));
    if (!canonicalHost) {
      return url;
    }
    urlObj.hostname = canonicalHost;
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Normalize social media URLs before sending them to Cobalt
export function normalizeSocialMediaUrlForCobalt(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();

    const canonicalHost = EMBED_FIXER_HOSTS.get(normalizeHost(hostname));
    if (canonicalHost) {
      urlObj.hostname = canonicalHost;
      hostname = canonicalHost;
    }

    if (X_HOST_ALIASES.has(hostname) && /^\/(?:[^/]+|i)\/status\/\d+\/?$/i.test(urlObj.pathname)) {
      urlObj.hostname = 'twitter.com';
      urlObj.hash = '';

      for (const param of X_STATUS_TRACKING_PARAMS) {
        urlObj.searchParams.delete(param);
      }

      if ([...urlObj.searchParams.keys()].length === 0) {
        urlObj.search = '';
      }
    }

    return urlObj.toString();
  } catch {
    return url;
  }
}

// Hosts cobalt handles; each also matches its subdomains (www., m., vm., clips. ...).
const SOCIAL_MEDIA_DOMAINS = [
  'twitter.com',
  'x.com',
  // Embed-fixer mirrors (rewritten to canonical hosts before hitting Cobalt)
  ...EMBED_FIXER_HOSTS.keys(),
  'bsky.app',
  'tiktok.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'reddit.com',
  'v.redd.it',
  'facebook.com',
  'fb.watch',
  // pinterest intentionally NOT listed: Cobalt 11 returns error.api.fetch.empty and yt-dlp's
  // extractor has been globally broken since ~2025-06 (yt-dlp #13554). Pinterest is handled by
  // the custom JSON-LD extractor in pinterest.js instead, routed before this list is consulted.
  // twitch: cobalt only handles clips (clips.twitch.tv + twitch.tv/<channel>/clip/<slug>),
  // matched host-only here, non-clip twitch URLs route through and get a curated error.
  'twitch.tv',
  'soundcloud.com', // also covers m./on. subdomains + short links
  'tumblr.com', // covers <blog>.tumblr.com and www.tumblr.com
  'streamable.com',
  'dailymotion.com',
  'dai.ly', // dailymotion short links
  'snapchat.com', // covers t.snapchat.com spotlight links
];

export function isSocialMediaUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = normalizeHost(urlObj.hostname);

    return SOCIAL_MEDIA_DOMAINS.some(
      domain => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

// cobalt 11 prefixes some Streamable links with a stray scheme: `https:https://cdn-cf-west...`.
export const repairUrl = url =>
  typeof url === 'string' ? url.replace(/^https?:(?=https?:\/\/)/i, '') : url;

async function callCobaltApi(apiUrl, url, retryCount = 0, maxRetries = 3) {
  const attemptNum = retryCount + 1;
  const normalizedUrl = normalizeSocialMediaUrlForCobalt(url);

  if (normalizedUrl !== url) {
    logger.debug(`Normalized social media URL for Cobalt: ${url} -> ${normalizedUrl}`);
  }

  logger.debug(
    `Calling Cobalt API at ${apiUrl} with URL: ${normalizedUrl} (attempt ${attemptNum}/${maxRetries})`
  );

  try {
    const response = await axios.post(
      apiUrl,
      {
        url: normalizedUrl,
        videoQuality: 'max',
        audioFormat: 'mp3',
        downloadMode: 'auto',
        filenameStyle: 'pretty',
      },
      {
        timeout: 60000, // 60 second timeout
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );

    logger.debug(`Cobalt API response status: ${response.status}`);
    if (response.status !== 200) {
      throw new NetworkError(`cobalt api returned status ${response.status}`);
    }

    const data = response.data;
    if (data?.url) data.url = repairUrl(data.url);
    for (const item of data?.picker ?? []) item.url = repairUrl(item.url);
    return data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      logger.error(`Cobalt API error response: status=${status}, data=${JSON.stringify(data)}`);

      const errorAnalysis = analyzeError(data, error);

      if (errorAnalysis.errorCode) {
        logger.error(`Cobalt error code: ${errorAnalysis.errorCode}`);
        if (errorAnalysis.context) {
          logger.error(`Error context: ${JSON.stringify(errorAnalysis.context)}`);
        }
      }

      // If content doesn't exist, don't retry
      if (errorAnalysis.isNotFound) {
        const notFoundMessage =
          errorAnalysis.userMessage || 'content not found, deleted, or unavailable';
        logger.error(`Content error: ${notFoundMessage}`);
        throw new NetworkError(notFoundMessage);
      }

      if (errorAnalysis.isRateLimit && retryCount < maxRetries - 1) {
        // Calculate exponential backoff delay: 1s, 2s, 4s
        const delayMs = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `Rate limit detected, retrying in ${delayMs}ms (attempt ${attemptNum}/${maxRetries})`
        );
        await sleep(delayMs);
        return callCobaltApi(apiUrl, url, retryCount + 1, maxRetries);
      }

      let message = null;

      // First priority: Use our user-friendly message if available
      if (errorAnalysis.userMessage) {
        message = errorAnalysis.userMessage;
      }
      // Second priority: Extract error message from response
      else if (typeof data?.text === 'string') {
        message = data.text;
      } else if (typeof data?.message === 'string') {
        message = data.message;
      } else if (typeof data?.error === 'string') {
        message = data.error;
      } else if (data?.error && typeof data.error === 'object') {
        message = data.error.message || data.error.text || JSON.stringify(data.error);
      } else if (data) {
        message = typeof data === 'string' ? data : JSON.stringify(data);
      }

      if (!message) {
        message = `Cobalt API error: ${status}`;
      }

      throw new NetworkError(message);
    }
    if (error.code === 'ECONNABORTED') {
      logger.error('Cobalt API request timed out');
      throw new NetworkError('cobalt api request timed out');
    }
    if (error.code === 'ECONNREFUSED') {
      logger.error('Cobalt service connection refused - is it running?');
      throw new NetworkError('cobalt service is not available');
    }
    logger.error(`Cobalt API call failed: ${error.message}, code: ${error.code}`);
    throw new NetworkError('failed to reach the download service. please try again later.');
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DISPOSITION_NAME = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;

// Streams a cobalt (or source) URL to disk. {what} names the file in user-facing errors.
async function fetchCobaltFile(url, { accept, timeout, maxSize, what, failMessage }) {
  try {
    const file = await fetchToFile(
      url,
      {
        timeout,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
        headers: { 'User-Agent': BROWSER_UA, Accept: accept, Referer: url },
      },
      { maxSize }
    );
    // cobalt's tunnel answers 200 with no body when its own fetch fails (seen on Bluesky HLS).
    if (file.size === 0) throw new NetworkError('cobalt returned an empty file');
    const match = (file.headers['content-disposition'] || '').match(DISPOSITION_NAME);
    return { ...file, dispositionName: match?.[1]?.replace(/['"]/g, '') || null };
  } catch (error) {
    if (error.code === 'TOO_LARGE' || error.response?.status === 413) {
      throw new ValidationError(`${what} is too large (max ${maxSize / (1024 * 1024)}mb)`);
    }
    if (error instanceof NetworkError) throw error;
    if (error.response?.status === 404) throw new NetworkError(`${what} not found at url`);
    if (error.code === 'ECONNABORTED') throw new NetworkError(`${what} download timed out`);
    logger.warn(`Cobalt ${what} download failed: ${error.message}`);
    throw new NetworkError(failMessage ?? `${what} could not be downloaded`);
  }
}

const PHOTO_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

async function downloadPhoto(photoUrl, index, isAdminUser = false, maxSize = Infinity) {
  const file = await fetchCobaltFile(photoUrl, {
    accept: 'image/*,*/*',
    timeout: 60000,
    maxSize: isAdminUser ? Infinity : maxSize,
    what: `photo ${index + 1}`,
  });
  const contentType = file.headers['content-type'] || 'image/jpeg';
  const filename =
    file.dispositionName ?? `photo_${index + 1}${PHOTO_EXTENSIONS[contentType] || '.jpg'}`;
  logger.debug(
    `Downloaded photo ${index + 1}: ${filename}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename });
}

async function downloadVideo(videoUrl, index, isAdminUser = false, maxSize = Infinity) {
  const file = await fetchCobaltFile(videoUrl, {
    accept: 'video/*,*/*',
    timeout: 300000,
    maxSize: isAdminUser ? Infinity : maxSize,
    what: `video ${index + 1}`,
  });
  const named = file.dispositionName ?? `video_${index + 1}.mp4`;
  const contentType = resolveContentType(file.headers['content-type'], named, file.head);
  const filename =
    file.dispositionName ?? `video_${index + 1}${CONTENT_TYPE_EXTENSIONS[contentType] || '.mp4'}`;
  logger.debug(
    `Downloaded video ${index + 1}: ${filename}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename });
}

async function downloadMediaFromPicker(pickerArray, isAdminUser = false, maxSize = Infinity) {
  const mediaItems = pickerArray.filter(
    item => (item.type === 'photo' || item.type === 'video') && item.url
  );

  if (mediaItems.length === 0) {
    throw new NetworkError('no media files (photos or videos) found in picker response');
  }

  logger.debug(
    `Found ${mediaItems.length} media items in picker response (${mediaItems.filter(i => i.type === 'photo').length} photos, ${mediaItems.filter(i => i.type === 'video').length} videos)`
  );

  const results = await mapLimit(mediaItems, ITEM_FANOUT, (item, index) =>
    item.type === 'photo'
      ? downloadPhoto(item.url, index, isAdminUser, maxSize)
      : downloadVideo(item.url, index, isAdminUser, maxSize)
  );
  logger.debug(`Successfully downloaded ${results.length} media items from picker`);

  return results;
}

// Cobalt's tunnel URLs carry its Docker hostname ("cobalt"), which only resolves inside the Docker network
function replaceTunnelHostname(url, apiUrl) {
  try {
    const urlObj = new URL(url);
    const apiUrlObj = new URL(apiUrl);

    if (urlObj.hostname !== apiUrlObj.hostname) {
      urlObj.hostname = apiUrlObj.hostname;
      if (apiUrlObj.port) {
        urlObj.port = apiUrlObj.port;
      }
      logger.debug(`Replacing tunnel hostname: ${url} -> ${urlObj.toString()}`);
      return urlObj.toString();
    }
    return url;
  } catch (error) {
    logger.warn(`Failed to replace tunnel hostname: ${error.message}, using original URL`);
    return url;
  }
}

async function downloadFromCobalt(
  cobaltResponse,
  isAdminUser = false,
  maxSize = Infinity,
  apiUrl = null
) {
  // Cobalt API returns different response formats depending on the platform

  // Check for picker response (e.g., Twitter with multiple photos/videos)
  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    logger.debug('Detected picker response with media files');
    return await downloadMediaFromPicker(cobaltResponse.picker, isAdminUser, maxSize);
  }

  let videoUrl = null;
  let filename = 'video.mp4';

  if (cobaltResponse.status === 'success') {
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
    } else if (cobaltResponse.video) {
      videoUrl = cobaltResponse.video;
    } else if (cobaltResponse.audio) {
      videoUrl = cobaltResponse.audio;
    }

    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    } else if (cobaltResponse.text) {
      // Sometimes filename is in text field
      const textMatch = cobaltResponse.text.match(/filename[^:]*:\s*([^\n]+)/i);
      if (textMatch) {
        filename = textMatch[1].trim();
      }
    }
  } else if (cobaltResponse.status === 'tunnel') {
    // Handle tunnel response - Cobalt returns a tunnel URL that needs to be accessed
    logger.debug('Detected tunnel response from Cobalt');
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
      // Replace Docker hostname with API URL hostname if needed
      if (apiUrl) {
        videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
      }
    } else {
      throw new NetworkError('cobalt tunnel response missing url');
    }

    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    }
  } else if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'cobalt api returned an error');
  } else {
    const possibleKeys = ['url', 'video', 'videoUrl', 'downloadUrl', 'directUrl'];
    for (const key of possibleKeys) {
      if (cobaltResponse[key]) {
        videoUrl = cobaltResponse[key];
        if (apiUrl && videoUrl.includes('/tunnel')) {
          videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
        }
        break;
      }
    }
    filename = cobaltResponse.filename || filename;
  }

  if (!videoUrl) {
    throw new NetworkError('cobalt api did not return a video url');
  }

  const file = await fetchCobaltFile(videoUrl, {
    accept: '*/*',
    timeout: 300000,
    maxSize: isAdminUser ? Infinity : maxSize,
    what: 'file',
    failMessage: 'the download failed. the content may be unavailable.',
  });
  const declared = file.headers['content-type'];
  const generic = declared === 'application/octet-stream' || declared === 'binary/octet-stream';
  const named = file.dispositionName ?? filename;
  const contentType = resolveContentType(generic ? '' : declared, named, file.head);
  const finalName = normalizeFilenameForContentType(named, contentType);
  logger.debug(
    `Downloaded file: ${finalName}, size: ${file.size} bytes, content-type: ${contentType}`
  );
  return withExtension({ ...file, contentType, filename: finalName });
}

export async function getCobaltMediaUrls(apiUrl, url) {
  const cobaltResponse = await callCobaltApi(apiUrl, url);

  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    const items = cobaltResponse.picker
      .filter(item => (item.type === 'photo' || item.type === 'video') && item.url)
      .map(item => ({ url: item.url, type: item.type, filename: null }));

    // One tunnelled slide means the gallery can't be served as links without dropping it.
    if (items.length === 0 || items.some(item => item.url.includes('/tunnel'))) {
      return { urls: [], direct: false, response: cobaltResponse };
    }
    return { urls: items, direct: true, response: cobaltResponse };
  }

  if (cobaltResponse.status === 'redirect' && cobaltResponse.url) {
    return {
      urls: [
        {
          url: cobaltResponse.url,
          type: 'video',
          filename: cobaltResponse.filename || null,
        },
      ],
      direct: true,
      response: cobaltResponse,
    };
  }

  if (cobaltResponse.status === 'tunnel') {
    // Tunnel URLs point at the local cobalt container and are useless to Discord users
    return { urls: [], direct: false, response: cobaltResponse };
  }

  if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'cobalt api returned an error');
  }

  return { urls: [], direct: false, response: cobaltResponse };
}

// Get the byte size of a remote media URL without downloading it, via a ranged GET (more widely supported than HEAD on media CDNs)
export async function getRemoteContentLength(mediaUrl) {
  try {
    const response = await axios.get(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-0',
      },
      responseType: 'stream',
      timeout: 10000,
      maxRedirects: 5,
    });
    // Only the headers are needed; a host that ignores Range would otherwise send the whole file.
    response.data?.destroy?.();
    // content-range: "bytes 0-0/12345678" - the total after the slash is the full size
    const contentRange = response.headers['content-range'] || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    if (totalMatch) {
      return parseInt(totalMatch[1], 10);
    }
    // Server ignored the Range header and sent the whole file
    const contentLength = parseInt(response.headers['content-length'] || '', 10);
    return Number.isFinite(contentLength) && response.status === 200 ? contentLength : null;
  } catch (error) {
    logger.warn(`Failed to get remote content length: ${error.message}`);
    return null;
  }
}

export async function downloadFromSocialMedia(
  apiUrl,
  url,
  isAdminUser = false,
  maxSize = Infinity,
  prefetched = null
) {
  logger.debug(`Attempting to download from social media URL via Cobalt: ${url}`);

  try {
    const cobaltResponse = prefetched ?? (await callCobaltApi(apiUrl, url));
    logger.debug('Cobalt API call successful, downloading media');
    const result = await downloadFromCobalt(cobaltResponse, isAdminUser, maxSize, apiUrl);

    // Check if result is an array (multiple photos) or single object
    if (Array.isArray(result)) {
      logger.debug(
        `Successfully downloaded ${result.length} photos from Cobalt (total size: ${result.reduce((sum, r) => sum + r.size, 0)} bytes)`
      );
    } else {
      logger.debug(
        `Successfully downloaded media from Cobalt: ${result.filename} (${result.size} bytes, content-type: ${result.contentType})`
      );
    }
    return result;
  } catch (error) {
    logger.warn(`Cobalt download failed: ${error.message}`);
    throw error;
  }
}
