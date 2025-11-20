import axios from 'axios';
import { createLogger } from './logger.js';
import { NetworkError } from './errors.js';

const logger = createLogger('cobalt');

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
 * Call Cobalt API to get video information
 * @param {string} apiUrl - Cobalt API URL
 * @param {string} url - Social media URL to process
 * @returns {Promise<Object>} Cobalt API response
 */
async function callCobaltApi(apiUrl, url) {
  logger.info(`Calling Cobalt API at ${apiUrl} with URL: ${url}`);
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
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      logger.error(`Cobalt API error response: status=${status}, data=${JSON.stringify(data)}`);

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
 * Download video from Cobalt response
 * @param {Object} cobaltResponse - Response from Cobalt API
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
 */
async function downloadFromCobalt(cobaltResponse, isAdminUser = false, maxSize = Infinity) {
  // Cobalt API returns different response formats depending on the platform
  // Check for direct video URL first
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
  } else if (cobaltResponse.status === 'error') {
    throw new NetworkError(cobaltResponse.text || 'Cobalt API returned an error');
  } else {
    // Try to find video URL in response object
    const possibleKeys = ['url', 'video', 'videoUrl', 'downloadUrl', 'directUrl'];
    for (const key of possibleKeys) {
      if (cobaltResponse[key]) {
        videoUrl = cobaltResponse[key];
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
      timeout: 120000, // 2 minute timeout for video downloads
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
 * Download video from social media URL using Cobalt
 * @param {string} apiUrl - Cobalt API URL
 * @param {string} url - Social media URL
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {Promise<Object>} Object with buffer, contentType, size, and filename
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
    logger.info('Cobalt API call successful, downloading video');
    const result = await downloadFromCobalt(cobaltResponse, isAdminUser, maxSize);
    logger.info(
      `Successfully downloaded video from Cobalt: ${result.filename} (${result.size} bytes, content-type: ${result.contentType})`
    );
    return result;
  } catch (error) {
    logger.warn(`Cobalt download failed: ${error.message}`);
    throw error;
  }
}
