import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';

const logger = createLogger('cobalt');

/**
 * Custom error for rate limiting
 */
export class RateLimitError extends NetworkError {
  constructor(message, retryAfter = null) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Check if error response indicates rate limiting vs content not found
 * @param {Object} data - Cobalt API error response data
 * @param {number} responseTime - Time taken for request in ms
 * @param {Object} errorObj - Full axios error object
 * @returns {Object} { isRateLimit: boolean, isNotFound: boolean }
 */
function analyzeError(data, responseTime, errorObj) {
  const result = { isRateLimit: false, isNotFound: false };

  // Check for explicit rate limit indicators
  if (data?.error?.code && data.error.code.includes('rate')) {
    result.isRateLimit = true;
    return result;
  }

  // Check HTTP status code (429 is definitive rate limit)
  if (errorObj?.response?.status === 429) {
    result.isRateLimit = true;
    return result;
  }

  // error.api.fetch.empty is ambiguous - use heuristics
  if (data?.error?.code === 'error.api.fetch.empty' || data?.code === 'error.api.fetch.empty') {
    // Check response text for clues
    const errorText = (data?.error?.text || data?.text || '').toLowerCase();

    // Explicit "not found" or "doesn't exist" messages
    if (
      errorText.includes('not found') ||
      errorText.includes("doesn't exist") ||
      errorText.includes('unavailable') ||
      errorText.includes('deleted')
    ) {
      result.isNotFound = true;
      return result;
    }

    // Response timing heuristic:
    // - Instant failure (< 1s) often means content doesn't exist
    // - Slower failure (> 2s) suggests rate limiting or network issues
    if (responseTime < 1000) {
      logger.info(`Fast failure (${responseTime}ms) suggests content may not exist`);
      result.isNotFound = true;
      return result;
    } else if (responseTime > 2000) {
      logger.info(`Slow failure (${responseTime}ms) suggests rate limiting`);
      result.isRateLimit = true;
      return result;
    }

    // Default to rate limit for ambiguous cases (conservative approach)
    // User can still cancel if they know content doesn't exist
    logger.warn(`Ambiguous error.api.fetch.empty (${responseTime}ms) - assuming rate limit`);
    result.isRateLimit = true;
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

/**
 * Parse Retry-After header value to milliseconds
 * @param {string|number} retryAfter - Retry-After header value (seconds as number/string, or HTTP date string)
 * @returns {number|null} Milliseconds to wait, or null if invalid
 */
function parseRetryAfter(retryAfter) {
  if (retryAfter == null) {
    return null;
  }

  // If it's a number (seconds), convert to milliseconds
  if (typeof retryAfter === 'number') {
    return retryAfter * 1000;
  }

  // If it's a string that's a number (seconds)
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try to parse as HTTP date
  try {
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const now = Date.now();
      const waitMs = date.getTime() - now;
      return waitMs > 0 ? waitMs : null;
    }
  } catch {
    // Invalid date format
  }

  return null;
}

/**
 * Social media domains that Cobalt can handle
 */
const SOCIAL_MEDIA_DOMAINS = [
  'twitter.com',
  'x.com',
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
  'threads.net',
  'www.threads.net',
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
  logger.info(
    `Calling Cobalt API at ${apiUrl} with URL: ${url} (attempt ${attemptNum}/${maxRetries})`
  );

  const startTime = Date.now();

  try {
    const response = await axios.post(
      apiUrl,
      {
        url: url,
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
      throw new NetworkError(`Cobalt API returned status ${response.status}`);
    }

    return response.data;
  } catch (error) {
    const responseTime = Date.now() - startTime;

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      logger.error(
        `Cobalt API error response: status=${status}, data=${JSON.stringify(data)}, responseTime=${responseTime}ms`
      );

      // Analyze error to determine if it's rate limiting or not found
      const errorAnalysis = analyzeError(data, responseTime, error);

      // If content doesn't exist, don't retry
      if (errorAnalysis.isNotFound) {
        logger.error('Content appears to be deleted, unavailable, or does not exist');
        throw new NetworkError('content not found, deleted, or unavailable');
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

      // Extract error message, ensuring it's always a string
      let message = null;
      if (typeof data?.text === 'string') {
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

      // If this is a rate limit error after all retries, throw RateLimitError with retry timing
      if (errorAnalysis.isRateLimit) {
        // Extract Retry-After header if available (can be seconds or HTTP date)
        const retryAfterHeader = error.response?.headers?.['retry-after'];
        let retryAfterMs = parseRetryAfter(retryAfterHeader);

        // Default to 5 minutes if not provided or invalid
        const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000; // 5 minutes
        if (retryAfterMs == null || retryAfterMs <= 0) {
          retryAfterMs = DEFAULT_RETRY_AFTER_MS;
          logger.warn(`No valid Retry-After header, using default ${DEFAULT_RETRY_AFTER_MS}ms`);
        } else {
          logger.info(`Extracted Retry-After: ${retryAfterMs}ms from header: ${retryAfterHeader}`);
        }

        throw new RateLimitError(message, retryAfterMs);
      }

      throw new NetworkError(message);
    }
    if (error.code === 'ECONNABORTED') {
      logger.error('Cobalt API request timed out');
      throw new NetworkError('Cobalt API request timed out');
    }
    if (error.code === 'ECONNREFUSED') {
      logger.error('Cobalt service connection refused - is it running?');
      throw new NetworkError('Cobalt service is not available');
    }
    logger.error(`Cobalt API call failed: ${error.message}, code: ${error.code}`);
    throw new NetworkError(`Failed to call Cobalt API: ${error.message}`);
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
      throw new NetworkError(`Photo ${index + 1} file is too large`);
    }
    if (error.response?.status === 404) {
      throw new NetworkError(`Photo ${index + 1} not found at URL`);
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError(`Photo ${index + 1} download timed out`);
    }
    throw new NetworkError(`Failed to download photo ${index + 1}: ${error.message}`);
  }
}

/**
 * Download multiple photos from picker array
 * @param {Array} pickerArray - Array of picker items from Cobalt response
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Array>} Array of objects with buffer, contentType, size, and filename
 */
async function downloadPhotosFromPicker(pickerArray, isAdminUser = false, maxSize = Infinity) {
  // Filter for photo items only
  const photoItems = pickerArray.filter(item => item.type === 'photo' && item.url);

  if (photoItems.length === 0) {
    throw new NetworkError('No photos found in picker response');
  }

  logger.info(`Found ${photoItems.length} photos in picker response`);

  // Download all photos
  const downloadPromises = photoItems.map((item, index) =>
    downloadPhoto(item.url, index, isAdminUser, maxSize)
  );

  const results = await Promise.all(downloadPromises);
  logger.info(`Successfully downloaded ${results.length} photos from picker`);

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

  // Check for picker response (e.g., TikTok slideshows with photos)
  if (
    cobaltResponse.status === 'picker' &&
    cobaltResponse.picker &&
    Array.isArray(cobaltResponse.picker)
  ) {
    logger.info('Detected picker response with photos');
    return await downloadPhotosFromPicker(cobaltResponse.picker, isAdminUser, maxSize);
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
      throw new NetworkError('Cobalt tunnel response missing URL');
    }

    // Get filename from response if available
    if (cobaltResponse.filename) {
      filename = cobaltResponse.filename;
    }
  } else if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'Cobalt API returned an error');
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
    throw new NetworkError('Cobalt API did not return a video URL');
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
      throw new NetworkError('Video file is too large');
    }
    if (error.response?.status === 404) {
      throw new NetworkError('Video file not found at Cobalt URL');
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError('Video download timed out');
    }
    throw new NetworkError(`Failed to download video from Cobalt: ${error.message}`);
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
