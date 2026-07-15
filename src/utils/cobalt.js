import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';

const logger = createLogger('cobalt');

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

/**
 * Get user-friendly error message for a Cobalt API error code
 * @param {string} errorCode - The error code from Cobalt API
 * @param {Object} context - Additional context (e.g., service name)
 * @returns {string} User-friendly error message
 */
function getCobaltErrorMessage(errorCode, context = {}) {
  if (!errorCode) {
    return null;
  }

  // Handle error.api.link.unsupported with service context
  if (errorCode === 'error.api.link.unsupported' && context?.service) {
    return `the service "${context.service}" is not supported by cobalt`;
  }

  return COBALT_ERROR_MESSAGES[errorCode] || null;
}

/**
 * Classify a Cobalt API error response.
 * Rate limiting is only assumed on explicit signals (HTTP 429 or a rate error code);
 * everything else is either "not found" (don't retry) or a plain failure.
 * @param {Object} data - Cobalt API error response data
 * @param {Object} errorObj - Full axios error object
 * @returns {Object} { isRateLimit, isNotFound, userMessage, errorCode, context }
 */
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

    // Get user-friendly message
    const friendlyMessage = getCobaltErrorMessage(errorCode, errorContext);
    if (friendlyMessage) {
      result.userMessage = friendlyMessage;
    }
  }

  // Check for explicit rate limit indicators
  if (errorCode && errorCode.includes('rate')) {
    result.isRateLimit = true;
    return result;
  }

  // Check HTTP status code (429 is definitive rate limit)
  if (errorObj?.response?.status === 429) {
    result.isRateLimit = true;
    return result;
  }

  // Handle specific error codes
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

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
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

// Embed-fixer mirror domains (FxEmbed/FxTwitter, BetterTwitFix, and community
// instances) mapped to the canonical host Cobalt understands. Cobalt doesn't
// know these hosts, so they must always be rewritten before the API call.
const EMBED_FIXER_HOSTS = new Map([
  // FxEmbed official (fxtwitter/fixupx) + legacy domains
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
  // FxEmbed for Bluesky
  ['fxbsky.app', 'bsky.app'],
]);

/**
 * Normalize social media URLs before sending them to Cobalt.
 * X/Twitter share links commonly include tracking params like ?s=46 which are
 * not needed for fetching and can make public-post handling less reliable.
 * @param {string} url - Original URL
 * @returns {string} Normalized URL
 */
export function normalizeSocialMediaUrlForCobalt(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();

    const canonicalHost = EMBED_FIXER_HOSTS.get(hostname.replace(/^www\./, ''));
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

/**
 * Social media domains that Cobalt can handle
 */
const SOCIAL_MEDIA_DOMAINS = [
  'twitter.com',
  'x.com',
  // Embed-fixer mirrors (rewritten to canonical hosts before hitting Cobalt)
  ...EMBED_FIXER_HOSTS.keys(),
  'bsky.app',
  'tiktok.com',
  'vm.tiktok.com',
  'instagram.com',
  'www.instagram.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'm.youtube.com',
  'reddit.com',
  'www.reddit.com',
  'v.redd.it',
  'facebook.com',
  'www.facebook.com',
  'fb.watch',
  // pinterest intentionally NOT listed: Cobalt 11 returns error.api.fetch.empty and yt-dlp's
  // extractor has been globally broken since ~2025-06 (Pinterest serves a fake 404 to its
  // resource API even for public pins, with or without cookies — yt-dlp #13554). Downloads
  // never succeed, so we reject Pinterest URLs upfront with the honest "unsupported platform"
  // message instead of a misleading "deleted/private" error + a wasted yt-dlp fallback attempt.
  // twitch: cobalt only handles clips (clips.twitch.tv + twitch.tv/<channel>/clip/<slug>),
  // matched host-only here — non-clip twitch URLs route through and get a curated error.
  'twitch.tv',
  'clips.twitch.tv',
  'soundcloud.com', // also covers m./on. subdomains + short links
  'tumblr.com', // covers <blog>.tumblr.com and www.tumblr.com
  'streamable.com',
  'dailymotion.com',
  'dai.ly', // dailymotion short links
  'snapchat.com', // covers t.snapchat.com spotlight links
];

/**
 * Check if a URL is from a social media platform
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is from a social media platform
 */
export function isSocialMediaUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');

    return SOCIAL_MEDIA_DOMAINS.some(domain => {
      const normalizedDomain = domain.replace(/^www\./, '');
      return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
    });
  } catch {
    return false;
  }
}

/**
 * Call Cobalt API to get video information with retry logic
 * @param {string} apiUrl - Cobalt API URL
 * @param {string} url - Social media URL to process
 * @param {number} retryCount - Current retry attempt (0-based)
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise<Object>} Cobalt API response
 */
async function callCobaltApi(apiUrl, url, retryCount = 0, maxRetries = 3) {
  const attemptNum = retryCount + 1;
  const normalizedUrl = normalizeSocialMediaUrlForCobalt(url);

  if (normalizedUrl !== url) {
    logger.info(`Normalized social media URL for Cobalt: ${url} -> ${normalizedUrl}`);
  }

  logger.info(
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

    logger.info(`Cobalt API response status: ${response.status}`);
    if (response.status !== 200) {
      throw new NetworkError(`cobalt api returned status ${response.status}`);
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      logger.error(`Cobalt API error response: status=${status}, data=${JSON.stringify(data)}`);

      // Analyze error to determine if it's rate limiting or not found
      const errorAnalysis = analyzeError(data, error);

      // Log error details
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

      // If rate limited and we have retries left, retry with backoff
      if (errorAnalysis.isRateLimit && retryCount < maxRetries - 1) {
        // Calculate exponential backoff delay: 1s, 2s, 4s
        const delayMs = Math.pow(2, retryCount) * 1000;
        logger.warn(
          `Rate limit detected, retrying in ${delayMs}ms (attempt ${attemptNum}/${maxRetries})`
        );
        await sleep(delayMs);
        return callCobaltApi(apiUrl, url, retryCount + 1, maxRetries);
      }

      // Determine the message to show to the user
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
        // If error is an object, try to extract message or stringify it
        message = data.error.message || data.error.text || JSON.stringify(data.error);
      } else if (data) {
        // If data exists but doesn't have standard error fields, stringify it
        message = typeof data === 'string' ? data : JSON.stringify(data);
      }

      // Fallback to status code if no message found
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

/**
 * Download a single photo from a URL
 * @param {string} photoUrl - Photo URL to download
 * @param {number} index - Index of the photo (for filename)
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
async function downloadPhoto(photoUrl, index, isAdminUser = false, maxSize = Infinity) {
  try {
    const response = await axios.get(photoUrl, {
      responseType: 'arraybuffer',
      timeout: 60000, // 1 minute timeout for photo downloads
      maxContentLength: isAdminUser ? Infinity : maxSize,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*',
        Referer: photoUrl,
      },
    });

    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    if (!isAdminUser && buffer.length > maxSize) {
      throw new ValidationError(
        `photo ${index + 1} file is too large (max ${maxSize / (1024 * 1024)}mb)`
      );
    }

    let contentType = response.headers['content-type'] || 'image/jpeg';

    // Extract filename from Content-Disposition if available
    let filename = `photo_${index + 1}.jpg`;
    const contentDisposition = response.headers['content-disposition'] || '';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '');
      }
    } else {
      // Try to infer extension from content type
      const extMap = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = extMap[contentType] || '.jpg';
      filename = `photo_${index + 1}${ext}`;
    }

    logger.info(
      `Downloaded photo ${index + 1}: ${filename}, size: ${buffer.length} bytes, content-type: ${contentType}`
    );

    return {
      buffer,
      contentType,
      size: buffer.length,
      filename,
    };
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new NetworkError(`photo ${index + 1} file is too large`);
    }
    if (error.response?.status === 404) {
      throw new NetworkError(`photo ${index + 1} not found at url`);
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError(`photo ${index + 1} download timed out`);
    }
    logger.warn(`Photo ${index + 1} download failed: ${error.message}`);
    throw new NetworkError(`photo ${index + 1} could not be downloaded`);
  }
}

/**
 * Download a single video from a URL (used in picker responses)
 * @param {string} videoUrl - Video URL to download
 * @param {number} index - Index of the video (for filename)
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
async function downloadVideo(videoUrl, index, isAdminUser = false, maxSize = Infinity) {
  try {
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 300000, // 5 minute timeout for video downloads
      maxContentLength: isAdminUser ? Infinity : maxSize,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'video/*,*/*',
        Referer: videoUrl,
      },
    });

    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    if (!isAdminUser && buffer.length > maxSize) {
      throw new ValidationError(
        `video ${index + 1} file is too large (max ${maxSize / (1024 * 1024)}mb)`
      );
    }

    let contentType = response.headers['content-type'] || 'video/mp4';

    // Extract filename from Content-Disposition if available
    let filename = `video_${index + 1}.mp4`;
    const contentDisposition = response.headers['content-disposition'] || '';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '');
      }
    } else {
      // Try to infer extension from content type
      const extMap = {
        'video/mp4': '.mp4',
        'video/quicktime': '.mov',
        'video/webm': '.webm',
        'video/x-msvideo': '.avi',
        'video/x-matroska': '.mkv',
      };
      const ext = extMap[contentType] || '.mp4';
      filename = `video_${index + 1}${ext}`;
    }

    logger.info(
      `Downloaded video ${index + 1}: ${filename}, size: ${buffer.length} bytes, content-type: ${contentType}`
    );

    return {
      buffer,
      contentType,
      size: buffer.length,
      filename,
    };
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new NetworkError(`video ${index + 1} file is too large`);
    }
    if (error.response?.status === 404) {
      throw new NetworkError(`video ${index + 1} not found at url`);
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError(`video ${index + 1} download timed out`);
    }
    logger.warn(`Video ${index + 1} download failed: ${error.message}`);
    throw new NetworkError(`video ${index + 1} could not be downloaded`);
  }
}

/**
 * Download multiple media files (photos and videos) from picker array
 * @param {Array} pickerArray - Array of picker items from Cobalt response
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Array>} Array of objects with buffer, contentType, size, and filename
 */
async function downloadMediaFromPicker(pickerArray, isAdminUser = false, maxSize = Infinity) {
  // Filter for photo and video items
  const mediaItems = pickerArray.filter(
    item => (item.type === 'photo' || item.type === 'video') && item.url
  );

  if (mediaItems.length === 0) {
    throw new NetworkError('no media files (photos or videos) found in picker response');
  }

  logger.info(
    `Found ${mediaItems.length} media items in picker response (${mediaItems.filter(i => i.type === 'photo').length} photos, ${mediaItems.filter(i => i.type === 'video').length} videos)`
  );

  // Download all media items
  const downloadPromises = mediaItems.map((item, index) => {
    if (item.type === 'photo') {
      return downloadPhoto(item.url, index, isAdminUser, maxSize);
    } else {
      return downloadVideo(item.url, index, isAdminUser, maxSize);
    }
  });

  const results = await Promise.all(downloadPromises);
  logger.info(`Successfully downloaded ${results.length} media items from picker`);

  return results;
}

/**
 * Replace hostname in URL with hostname from API URL
 * This is needed when Cobalt returns tunnel URLs with Docker hostnames (e.g., "cobalt")
 * that aren't resolvable from outside the Docker network
 * @param {string} url - URL to fix
 * @param {string} apiUrl - Cobalt API URL to extract hostname from
 * @returns {string} URL with replaced hostname
 */
function replaceTunnelHostname(url, apiUrl) {
  try {
    const urlObj = new URL(url);
    const apiUrlObj = new URL(apiUrl);

    // Replace hostname if it's different from the API URL hostname
    if (urlObj.hostname !== apiUrlObj.hostname) {
      urlObj.hostname = apiUrlObj.hostname;
      // Also replace port if API URL has a specific port
      if (apiUrlObj.port) {
        urlObj.port = apiUrlObj.port;
      }
      logger.info(`Replacing tunnel hostname: ${url} -> ${urlObj.toString()}`);
      return urlObj.toString();
    }
    return url;
  } catch (error) {
    logger.warn(`Failed to replace tunnel hostname: ${error.message}, using original URL`);
    return url;
  }
}

/**
 * Download video from Cobalt response
 * @param {Object} cobaltResponse - Response from Cobalt API
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @param {string} apiUrl - Cobalt API URL (used to fix tunnel hostnames)
 * @returns {Promise<Object|Array>} Object with buffer, contentType, size, and filename (or array of objects for picker)
 */
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
    logger.info('Detected picker response with media files');
    return await downloadMediaFromPicker(cobaltResponse.picker, isAdminUser, maxSize);
  }

  // Check for direct video URL
  let videoUrl = null;
  let filename = 'video.mp4';

  if (cobaltResponse.status === 'success') {
    // Check for direct video URL
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
    } else if (cobaltResponse.video) {
      videoUrl = cobaltResponse.video;
    } else if (cobaltResponse.audio) {
      videoUrl = cobaltResponse.audio;
    }

    // Get filename from response if available
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
    logger.info('Detected tunnel response from Cobalt');
    if (cobaltResponse.url) {
      videoUrl = cobaltResponse.url;
      // Replace Docker hostname with API URL hostname if needed
      if (apiUrl) {
        videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
      }
    } else {
      throw new NetworkError('cobalt tunnel response missing url');
    }

    // Get filename from response if available
    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    }
  } else if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'cobalt api returned an error');
  } else {
    // Try to find video URL in response object
    const possibleKeys = ['url', 'video', 'videoUrl', 'downloadUrl', 'directUrl'];
    for (const key of possibleKeys) {
      if (cobaltResponse[key]) {
        videoUrl = cobaltResponse[key];
        // If we have an API URL and the video URL looks like a tunnel URL, fix the hostname
        if (apiUrl && videoUrl.includes('/tunnel')) {
          videoUrl = replaceTunnelHostname(videoUrl, apiUrl);
        }
        break;
      }
    }
  }

  if (!videoUrl) {
    throw new NetworkError('cobalt api did not return a video url');
  }

  // Download the video
  try {
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 300000, // 5 minute timeout for video downloads
      maxContentLength: isAdminUser ? Infinity : maxSize,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
        Referer: videoUrl,
      },
    });

    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    if (!isAdminUser && buffer.length > maxSize) {
      throw new ValidationError(`file is too large (max ${maxSize / (1024 * 1024)}mb)`);
    }

    let contentType = response.headers['content-type'] || 'video/mp4';

    // Extract filename from Content-Disposition if available
    const contentDisposition = response.headers['content-disposition'] || '';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        filename = filenameMatch[1].replace(/['"]/g, '');
      }
    }

    // If content type is generic or missing, try to infer from filename
    if (
      !contentType ||
      contentType === 'application/octet-stream' ||
      contentType === 'binary/octet-stream'
    ) {
      const ext = filename.toLowerCase().split('.').pop();
      const extToMime = {
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
        avi: 'video/x-msvideo',
        mkv: 'video/x-matroska',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
      };
      if (extToMime[ext]) {
        contentType = extToMime[ext];
        logger.info(`Inferred content type from filename extension: ${contentType}`);
      } else {
        logger.warn(`Could not infer content type from extension ${ext}, using default video/mp4`);
        contentType = 'video/mp4';
      }
    }

    logger.info(
      `Downloaded file: ${filename}, size: ${buffer.length} bytes, content-type: ${contentType}`
    );

    return {
      buffer,
      contentType,
      size: buffer.length,
      filename,
    };
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new NetworkError('video file is too large');
    }
    if (error.response?.status === 404) {
      throw new NetworkError('video file not found at cobalt url');
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError('video download timed out');
    }
    logger.warn(`Cobalt video download failed: ${error.message}`);
    throw new NetworkError('the download failed. the content may be unavailable.');
  }
}

/**
 * Get direct media URLs from Cobalt without downloading anything.
 * Only returns URLs that are publicly reachable (redirect/picker responses).
 * Tunnel responses proxy through the local cobalt instance and are not usable
 * outside the Docker network, so they are reported as unavailable.
 * @param {string} apiUrl - Cobalt API URL
 * @param {string} url - Social media URL
 * @returns {Promise<{urls: Array<{url: string, type: string, filename: string|null}>, direct: boolean}>}
 *   direct is false when cobalt only offers a tunnel (caller should fall back to downloading)
 */
export async function getCobaltMediaUrls(apiUrl, url) {
  const cobaltResponse = await callCobaltApi(apiUrl, url);
  logger.info(`Cobalt API response (url-only mode): ${JSON.stringify(cobaltResponse)}`);

  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    const items = cobaltResponse.picker
      .filter(item => (item.type === 'photo' || item.type === 'video') && item.url)
      .filter(item => !item.url.includes('/tunnel'))
      .map(item => ({ url: item.url, type: item.type, filename: null }));

    if (items.length === 0) {
      return { urls: [], direct: false };
    }
    return { urls: items, direct: true };
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
    };
  }

  if (cobaltResponse.status === 'tunnel') {
    // Tunnel URLs point at the local cobalt container and are useless to Discord users
    return { urls: [], direct: false };
  }

  if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'cobalt api returned an error');
  }

  return { urls: [], direct: false };
}

/**
 * Get the byte size of a remote media URL without downloading it, via a ranged GET
 * (more widely supported than HEAD on media CDNs). Returns null when the size can't
 * be determined - callers should treat that as "unknown" and fall back to downloading.
 * @param {string} mediaUrl - Direct media URL (e.g. video.twimg.com)
 * @returns {Promise<number|null>} Size in bytes, or null if unknown
 */
export async function getRemoteContentLength(mediaUrl) {
  try {
    const response = await axios.get(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-0',
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      maxRedirects: 5,
    });
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

/**
 * Download video or photos from social media URL using Cobalt
 * @param {string} apiUrl - Cobalt API URL
 * @param {string} url - Social media URL
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Object|Array>} Object with buffer, contentType, size, and filename (or array for multiple photos)
 */
export async function downloadFromSocialMedia(
  apiUrl,
  url,
  isAdminUser = false,
  maxSize = Infinity
) {
  logger.info(`Attempting to download from social media URL via Cobalt: ${url}`);

  try {
    const cobaltResponse = await callCobaltApi(apiUrl, url);
    logger.info(`Cobalt API response: ${JSON.stringify(cobaltResponse)}`);
    logger.info('Cobalt API call successful, downloading media');
    const result = await downloadFromCobalt(cobaltResponse, isAdminUser, maxSize, apiUrl);

    // Check if result is an array (multiple photos) or single object
    if (Array.isArray(result)) {
      logger.info(
        `Successfully downloaded ${result.length} photos from Cobalt (total size: ${result.reduce((sum, r) => sum + r.size, 0)} bytes)`
      );
    } else {
      logger.info(
        `Successfully downloaded media from Cobalt: ${result.filename} (${result.size} bytes, content-type: ${result.contentType})`
      );
    }
    return result;
  } catch (error) {
    logger.warn(`Cobalt download failed: ${error.message}`);
    throw error;
  }
}
