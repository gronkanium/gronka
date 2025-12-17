import axios from 'axios';
import path from 'path';
import { createLogger } from './logger.js';
import { botConfig } from './config.js';
import { validateUrl } from './validation.js';
import { ValidationError, NetworkError } from './errors.js';
import { isSocialMediaUrl, downloadFromSocialMedia } from './cobalt.js';
import { isDiscordCdnUrl, getRefreshedAttachmentURL, getRequestHeaders } from './discord-cdn.js';
import { sanitizeFilename } from './validation.js';
import { hashBytesHex } from './hashing.js';

const logger = createLogger('file-downloader');

const {
  maxVideoSize: MAX_VIDEO_SIZE,
  maxImageSize: MAX_IMAGE_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
} = botConfig;

/**
 * Download video from Discord CDN
 * @param {string} url - Video URL
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @returns {Promise<Buffer>} Video file buffer
 */
export async function downloadVideo(url, isAdminUser = false) {
  // Validate URL to prevent SSRF
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(urlValidation.error);
  }

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000, // 60 second timeout
      maxContentLength: isAdminUser ? Infinity : MAX_VIDEO_SIZE,
      maxRedirects: 5,
      headers: getRequestHeaders(),
    });
    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    if (!isAdminUser && buffer.length > MAX_VIDEO_SIZE) {
      throw new ValidationError(
        `video file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb)`
      );
    }

    return buffer;
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new ValidationError(
        `video file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb)`
      );
    }
    throw new NetworkError(`failed to download video: ${error.message}`);
  }
}

/**
 * Download image from Discord CDN
 * @param {string} url - Image URL
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @returns {Promise<Buffer>} Image file buffer
 */
export async function downloadImage(url, isAdminUser = false) {
  // Validate URL to prevent SSRF
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(urlValidation.error);
  }

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000, // 60 second timeout
      maxContentLength: isAdminUser ? Infinity : MAX_IMAGE_SIZE,
      maxRedirects: 5,
      headers: getRequestHeaders(),
    });
    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    if (!isAdminUser && buffer.length > MAX_IMAGE_SIZE) {
      throw new ValidationError(
        `image file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb)`
      );
    }

    return buffer;
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new ValidationError(
        `image file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb)`
      );
    }
    throw new NetworkError(`failed to download image: ${error.message}`);
  }
}

/**
 * Download file from URL and detect content type
 * @param {string} url - File URL
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @param {Client} [client] - Optional Discord client for refreshing expired URLs
 * @returns {Promise<{buffer: Buffer, contentType: string, size: number, filename: string}>} File data and metadata
 */
export async function downloadFileFromUrl(url, isAdminUser = false, client = null) {
  // Validate URL to prevent SSRF
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    throw new ValidationError(urlValidation.error);
  }

  // Try to refresh Discord CDN URLs if client is available
  let actualUrl = url;
  if (client && isDiscordCdnUrl(url)) {
    try {
      actualUrl = await getRefreshedAttachmentURL(client, url);
      if (actualUrl !== url) {
        logger.info(`Using refreshed URL for Discord CDN attachment`);
      }
    } catch (error) {
      logger.warn(`Failed to refresh Discord URL, using original: ${error.message}`);
    }
  }

  // Check if URL is from social media and Cobalt is enabled
  // Skip Cobalt for Discord CDN URLs as they are handled directly
  if (COBALT_ENABLED && !isDiscordCdnUrl(actualUrl) && isSocialMediaUrl(actualUrl)) {
    try {
      logger.info(`Detected social media URL, attempting download via Cobalt`);
      const maxSize = isAdminUser ? Infinity : MAX_VIDEO_SIZE;
      return await downloadFromSocialMedia(COBALT_API_URL, actualUrl, isAdminUser, maxSize);
    } catch (cobaltError) {
      logger.warn(
        `Cobalt download failed, falling back to direct download: ${cobaltError.message}`
      );
      // Fall through to direct download
    }
  }

  try {
    const response = await axios.get(actualUrl, {
      responseType: 'arraybuffer',
      timeout: 60000, // 60 second timeout
      maxContentLength: isAdminUser ? Infinity : Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE),
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
      headers: getRequestHeaders(),
    });

    const buffer = Buffer.from(response.data);

    // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
    // Determine appropriate limit based on content type
    const contentType = response.headers['content-type'] || '';
    const isVideo =
      contentType.startsWith('video/') ||
      contentType.includes('video') ||
      /\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i.test(url);
    const isImage =
      contentType.startsWith('image/') ||
      contentType.includes('image') ||
      /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url);

    if (!isAdminUser) {
      if (isVideo && buffer.length > MAX_VIDEO_SIZE) {
        throw new ValidationError(
          `file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb for videos)`
        );
      }
      if (isImage && buffer.length > MAX_IMAGE_SIZE) {
        throw new ValidationError(
          `file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb for images)`
        );
      }
      // For unknown types, use the larger limit (video limit)
      if (!isVideo && !isImage && buffer.length > Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE)) {
        throw new ValidationError(
          `file is too large (max ${Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE) / (1024 * 1024)}mb)`
        );
      }
    }

    const contentDisposition = response.headers['content-disposition'] || '';

    // Extract filename from Content-Disposition header or URL
    let filename = 'file';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        filename = sanitizeFilename(filenameMatch[1].replace(/['"]/g, ''));
      }
    }
    if (filename === 'file') {
      // Try to extract from URL
      try {
        const urlPath = new URL(url).pathname;
        const urlFilename = path.basename(urlPath);
        if (urlFilename && urlFilename !== '/') {
          filename = sanitizeFilename(urlFilename);
        }
      } catch {
        // Invalid URL, keep default
      }
    }

    return {
      buffer,
      contentType,
      size: buffer.length,
      filename,
    };
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new ValidationError(
        `file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb for videos, ${MAX_IMAGE_SIZE / (1024 * 1024)}mb for images)`
      );
    }
    if (error.response?.status === 404) {
      throw new NetworkError('file not found at the provided URL');
    }
    if (error.response?.status === 403) {
      throw new NetworkError(
        'access denied to the file URL (may be expired or require authentication)'
      );
    }
    if (error.response?.status === 401) {
      throw new NetworkError('authentication required to access the file URL');
    }
    // Handle 500 errors for Discord CDN URLs - try refreshing if we haven't already
    if (error.response?.status === 500 && isDiscordCdnUrl(url) && client && actualUrl === url) {
      try {
        logger.info(`Got 500 error, attempting to refresh Discord URL`);
        const refreshedUrl = await getRefreshedAttachmentURL(client, url);
        if (refreshedUrl !== url) {
          // Retry with refreshed URL
          logger.info(`Retrying download with refreshed URL`);
          const retryResponse = await axios.get(refreshedUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: isAdminUser ? Infinity : Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE),
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400,
            headers: getRequestHeaders(),
          });
          const buffer = Buffer.from(retryResponse.data);

          // Validate buffer size (axios maxContentLength may not work if server doesn't send Content-Length header)
          const contentType = retryResponse.headers['content-type'] || '';
          const isVideo =
            contentType.startsWith('video/') ||
            contentType.includes('video') ||
            /\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i.test(refreshedUrl);
          const isImage =
            contentType.startsWith('image/') ||
            contentType.includes('image') ||
            /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(refreshedUrl);

          if (!isAdminUser) {
            if (isVideo && buffer.length > MAX_VIDEO_SIZE) {
              throw new ValidationError(
                `file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb for videos)`
              );
            }
            if (isImage && buffer.length > MAX_IMAGE_SIZE) {
              throw new ValidationError(
                `file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb for images)`
              );
            }
            // For unknown types, use the larger limit (video limit)
            if (!isVideo && !isImage && buffer.length > Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE)) {
              throw new ValidationError(
                `file is too large (max ${Math.max(MAX_VIDEO_SIZE, MAX_IMAGE_SIZE) / (1024 * 1024)}mb)`
              );
            }
          }

          const contentDisposition = retryResponse.headers['content-disposition'] || '';

          let filename = 'file';
          if (contentDisposition) {
            const filenameMatch = contentDisposition.match(
              /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
            );
            if (filenameMatch && filenameMatch[1]) {
              filename = sanitizeFilename(filenameMatch[1].replace(/['"]/g, ''));
            }
          }
          if (filename === 'file') {
            try {
              const urlPath = new URL(refreshedUrl).pathname;
              const urlFilename = path.basename(urlPath);
              if (urlFilename && urlFilename !== '/') {
                filename = sanitizeFilename(urlFilename);
              }
            } catch {
              // Invalid URL, keep default
            }
          }

          return {
            buffer,
            contentType,
            size: buffer.length,
            filename,
          };
        }
      } catch (refreshError) {
        logger.warn(`Failed to refresh and retry Discord URL: ${refreshError.message}`);
      }
      throw new NetworkError(
        'discord cdn returned an error. the url may be expired or invalid. please try using a fresh url from discord.'
      );
    }
    if (error.code === 'ECONNABORTED') {
      throw new NetworkError('request timed out while downloading file');
    }
    throw new NetworkError(`failed to download file from URL: ${error.message}`);
  }
}

/**
 * Parse Tenor GIF URL and extract the actual GIF file URL
 * @param {string} url - Tenor page URL (e.g., https://tenor.com/view/gm-gif-1914360746739225000)
 * @returns {Promise<string>} Direct URL to the GIF file
 */
export async function parseTenorUrl(url) {
  try {
    // Check if URL is a Tenor view URL
    const tenorViewPattern = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-(\d+)/i;
    const match = url.match(tenorViewPattern);

    if (!match) {
      throw new ValidationError('invalid Tenor URL format');
    }

    const gifId = match[2];
    logger.info(`Parsing Tenor URL, extracted GIF ID: ${gifId}`);

    // Try to fetch the page and parse meta tags
    try {
      const headers = getRequestHeaders();
      // Remove Discord referer for Tenor URLs
      delete headers.Referer;
      const response = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 5,
        headers,
      });

      const html = response.data;

      // Try to find the store-cache script tag with JSON data
      // Match script tag with id="store-cache" (attributes can be in any order)
      const storeCacheMatch = html.match(
        /<script[^>]*id=["']store-cache["'][^>]*>(.*?)<\/script>/is
      );
      if (storeCacheMatch && storeCacheMatch[1]) {
        try {
          const storeData = JSON.parse(storeCacheMatch[1]);
          // Navigate to gifs.byId[gifId].results[0].media_formats.gif.url
          if (
            storeData.gifs &&
            storeData.gifs.byId &&
            storeData.gifs.byId[gifId] &&
            storeData.gifs.byId[gifId].results &&
            storeData.gifs.byId[gifId].results[0] &&
            storeData.gifs.byId[gifId].results[0].media_formats &&
            storeData.gifs.byId[gifId].results[0].media_formats.gif &&
            storeData.gifs.byId[gifId].results[0].media_formats.gif.url
          ) {
            const gifUrl = storeData.gifs.byId[gifId].results[0].media_formats.gif.url;
            logger.info(`Found GIF URL from store-cache JSON: ${gifUrl}`);
            return gifUrl;
          }
        } catch (error) {
          logger.warn(`Failed to parse store-cache JSON: ${error.message}`);
        }
      }

      // Try to find og:image meta tag
      const ogImageMatch = html.match(
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
      );
      if (ogImageMatch && ogImageMatch[1]) {
        const gifUrl = ogImageMatch[1];
        logger.info(`Found GIF URL from og:image meta tag: ${gifUrl}`);
        return gifUrl;
      }

      // Try to find other meta tags that might contain the GIF URL
      const metaImageMatch = html.match(/<meta\s+name=["']image["']\s+content=["']([^"']+)["']/i);
      if (metaImageMatch && metaImageMatch[1]) {
        const gifUrl = metaImageMatch[1];
        logger.info(`Found GIF URL from image meta tag: ${gifUrl}`);
        return gifUrl;
      }

      // Try to find in JSON-LD structured data
      const jsonLdMatch = html.match(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/is
      );
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          if (jsonLd.image && typeof jsonLd.image === 'string') {
            logger.info(`Found GIF URL from JSON-LD: ${jsonLd.image}`);
            return jsonLd.image;
          }
          if (jsonLd.image && jsonLd.image.url) {
            logger.info(`Found GIF URL from JSON-LD image object: ${jsonLd.image.url}`);
            return jsonLd.image.url;
          }
        } catch {
          // Ignore JSON parsing errors
        }
      }
    } catch (error) {
      logger.warn(
        `Failed to parse Tenor page HTML: ${error.message}, falling back to direct URL pattern`
      );
    }

    // Fall back to direct URL pattern
    const directUrl = `https://c.tenor.com/${gifId}/tenor.gif`;
    logger.info(`Using fallback direct URL pattern: ${directUrl}`);
    return directUrl;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new NetworkError(`failed to parse Tenor URL: ${error.message}`);
  }
}

/**
 * Generate BLAKE3 hash of buffer
 * @param {Buffer} buffer - Data buffer
 * @returns {string} BLAKE3 hash in hex format
 */
export function generateHash(buffer) {
  return hashBytesHex(buffer);
}
