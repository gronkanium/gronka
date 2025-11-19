import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { convertToGif, getVideoMetadata, convertImageToGif } from './utils/video-processor.js';
import {
  gifExists,
  getGifPath,
  cleanupTempFiles,
  getStorageStats,
  saveGif,
  saveVideo,
  getVideoPath,
  videoExists,
  saveImage,
  getImagePath,
  imageExists,
  detectFileType,
} from './utils/storage.js';
import { createLogger } from './utils/logger.js';
import { botConfig } from './utils/config.js';
import { validateUrl, sanitizeFilename, validateFileExtension } from './utils/validation.js';
import { ConfigurationError, NetworkError, ValidationError } from './utils/errors.js';
import { isSocialMediaUrl, downloadFromSocialMedia } from './utils/cobalt.js';
import { getUserConfig, setUserConfig } from './utils/user-config.js';
import {
  trackUser,
  getUniqueUserCount,
  initializeUserTracking,
  trackRecentConversion,
  getRecentConversions,
} from './utils/user-tracking.js';
import {
  isGifFile,
  extractHashFromCdnUrl,
  checkLocalGif,
  optimizeGif,
  calculateSizeReduction,
  formatSizeMb,
} from './utils/gif-optimizer.js';

// Initialize logger
const logger = createLogger('bot');

// Configuration from centralized config
const {
  discordToken: DISCORD_TOKEN,
  clientId: CLIENT_ID,
  adminUserIds: ADMIN_USER_IDS,
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  maxGifWidth: MAX_GIF_WIDTH,
  maxGifDuration: MAX_GIF_DURATION,
  defaultFps: DEFAULT_FPS,
  maxVideoSize: MAX_VIDEO_SIZE,
  maxImageSize: MAX_IMAGE_SIZE,
  rateLimitCooldown: RATE_LIMIT_COOLDOWN,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
} = botConfig;

// Rate limiting: userId -> last use timestamp
const rateLimit = new Map();

// Store attachment info for modal submissions: customId -> { attachment, attachmentType, adminUser, preDownloadedBuffer }
const modalAttachmentCache = new Map();

// Clean up modal cache entries older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of modalAttachmentCache.entries()) {
    if (value.timestamp && now - value.timestamp > 5 * 60 * 1000) {
      modalAttachmentCache.delete(key);
    }
  }
}, 60 * 1000); // Run cleanup every minute

// Allowed video content types
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo', // AVI
  'video/x-matroska', // MKV
];

// Allowed image content types
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

/**
 * Check if user is an admin
 * @param {string} userId - Discord user ID
 * @returns {boolean} True if user is admin
 */
function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

/**
 * Check if user is rate limited
 * @param {string} userId - Discord user ID
 * @returns {boolean} True if user should wait
 */
function checkRateLimit(userId) {
  // Admins bypass rate limiting
  if (isAdmin(userId)) {
    logger.info(`Rate limit bypassed for admin user ${userId}`);
    return false;
  }

  const lastUse = rateLimit.get(userId);
  if (lastUse && Date.now() - lastUse < RATE_LIMIT_COOLDOWN) {
    return true;
  }
  rateLimit.set(userId, Date.now());
  return false;
}

/**
 * Check if URL is a Discord CDN URL
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is from Discord CDN
 */
function isDiscordCdnUrl(url) {
  try {
    const urlObj = new URL(url);
    return (
      urlObj.hostname === 'cdn.discordapp.com' ||
      urlObj.hostname === 'media.discordapp.net' ||
      urlObj.hostname.endsWith('.discordapp.com') ||
      urlObj.hostname.endsWith('.discordapp.net')
    );
  } catch {
    return false;
  }
}

/**
 * Check if attachment URL has expired
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is expired or invalid
 */
function isAttachmentExpired(url) {
  try {
    const urlObj = new URL(url);
    const expiry = urlObj.searchParams.get('ex');
    if (!expiry || expiry.length > 8) {
      return true;
    }
    // Parse hex expiry timestamp and compare with current time
    const expiryTime = parseInt(`0x${expiry}`, 16) * 1000;
    return Date.now() >= expiryTime;
  } catch {
    return true;
  }
}

/**
 * Refresh the attachment URL if expired using Discord's REST API
 * @param {Client} client - Discord client instance
 * @param {string} attachmentURL - Original attachment URL
 * @returns {Promise<string>} Refreshed URL or original URL if not needed
 */
async function getRefreshedAttachmentURL(client, attachmentURL) {
  try {
    const url = new URL(attachmentURL);

    // Check if it's a Discord CDN URL
    if (
      (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net') &&
      url.pathname.match(/^\/(?:ephemeral-)?attachments\/\d+\/\d+\//)
    ) {
      // Check if expired or missing query parameters
      if (isAttachmentExpired(attachmentURL) || !url.search || url.search.length === 0) {
        logger.info(`Refreshing expired or invalid Discord CDN URL: ${attachmentURL}`);
        // Use Discord's REST API to refresh the URL
        const response = await client.rest.post('/attachments/refresh-urls', {
          body: {
            attachment_urls: [attachmentURL],
          },
        });

        if (
          response.refreshed_urls &&
          response.refreshed_urls[0] &&
          response.refreshed_urls[0].refreshed
        ) {
          const refreshedURL = new URL(response.refreshed_urls[0].refreshed);
          refreshedURL.searchParams.set('animated', 'true');
          logger.info(`Successfully refreshed URL: ${refreshedURL.toString()}`);
          return refreshedURL.toString();
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to refresh attachment URL: ${error.message}`);
    // Return original URL if refresh fails
  }

  return attachmentURL;
}

/**
 * Get common headers for HTTP requests (needed for Discord CDN and other services)
 * @returns {Object} Headers object
 */
function getRequestHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    Referer: 'https://discord.com/',
  };
}

/**
 * Download video from Discord CDN
 * @param {string} url - Video URL
 * @param {boolean} isAdminUser - Whether the user is an admin (allows larger files)
 * @returns {Promise<Buffer>} Video file buffer
 */
async function downloadVideo(url, isAdminUser = false) {
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
    return Buffer.from(response.data);
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new ValidationError('video file is too large (max 500mb)');
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
async function downloadImage(url, isAdminUser = false) {
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
    return Buffer.from(response.data);
  } catch (error) {
    if (error.response?.status === 413 && !isAdminUser) {
      throw new ValidationError('image file is too large (max 50mb)');
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
async function downloadFileFromUrl(url, isAdminUser = false, client = null) {
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
    const contentType = response.headers['content-type'] || '';
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
      throw new ValidationError('file is too large (max 500mb for videos, 50mb for images)');
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
          const contentType = retryResponse.headers['content-type'] || '';
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
async function parseTenorUrl(url) {
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
 * Generate SHA-256 hash of buffer
 * @param {Buffer} buffer - Data buffer
 * @returns {string} SHA-256 hash in hex format
 */
function generateHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validate video attachment
 * @param {Attachment} attachment - Discord attachment
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @returns {Object} Validation result with error message if invalid
 */
function validateVideoAttachment(attachment, isAdminUser = false) {
  // Check if it's a video
  if (!attachment.contentType || !ALLOWED_VIDEO_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported video format. supported formats: mp4, mov, webm, avi, mkv`,
    };
  }

  // Check file size (admins bypass size limit)
  if (!isAdminUser && attachment.size > MAX_VIDEO_SIZE) {
    return {
      valid: false,
      error: `video file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb)`,
    };
  }

  if (isAdminUser && attachment.size > MAX_VIDEO_SIZE) {
    logger.info(
      `Video size limit bypassed for admin (${(attachment.size / (1024 * 1024)).toFixed(2)}MB > ${MAX_VIDEO_SIZE / (1024 * 1024)}MB)`
    );
  }

  return { valid: true };
}

/**
 * Validate image attachment
 * @param {Attachment} attachment - Discord attachment
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @returns {Object} Validation result with error message if invalid
 */
function validateImageAttachment(attachment, isAdminUser = false) {
  // Check if it's an image
  if (!attachment.contentType || !ALLOWED_IMAGE_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported image format. supported formats: png, jpg, jpeg, webp, gif`,
    };
  }

  // Check file size (admins bypass size limit)
  if (!isAdminUser && attachment.size > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `image file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb)`,
    };
  }

  if (isAdminUser && attachment.size > MAX_IMAGE_SIZE) {
    logger.info(
      `Image size limit bypassed for admin (${(attachment.size / (1024 * 1024)).toFixed(2)}MB > ${MAX_IMAGE_SIZE / (1024 * 1024)}MB)`
    );
  }

  return { valid: true };
}

/**
 * Process conversion from attachment to GIF
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment to convert
 * @param {string} attachmentType - Type of attachment ('video' or 'image')
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer (to avoid double download)
 * @param {Object} [options] - Optional conversion options (startTime, duration, width, fps, quality)
 */
async function processConversion(
  interaction,
  attachment,
  attachmentType,
  adminUser,
  preDownloadedBuffer = null,
  options = {}
) {
  const userId = interaction.user.id;
  const tempFiles = [];

  // Load user config
  const userConfig = await getUserConfig(userId);

  try {
    // Download file (video or image) if not already downloaded
    // Admins bypass size limits in download
    const fileBuffer =
      preDownloadedBuffer ||
      (attachmentType === 'video'
        ? await downloadVideo(attachment.url, adminUser)
        : await downloadImage(attachment.url, adminUser));

    // Generate hash
    const hash = generateHash(fileBuffer);

    // Check if GIF already exists
    const exists = await gifExists(hash, GIF_STORAGE_PATH);
    if (exists && !options.optimize) {
      const gifUrl = `${CDN_BASE_URL}/${hash}.gif`;
      logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
      await interaction.editReply({
        content: `gif already exists : ${gifUrl}`,
      });
      return;
    }

    // If optimization is requested and original GIF exists, we'll optimize it directly
    // Otherwise, we need to convert first
    const needsConversion = !exists;
    logger.info(
      `Starting ${attachmentType} to GIF conversion (hash: ${hash})${options.optimize ? ' with optimization' : ''}${exists ? ' (original GIF exists, will optimize)' : ''}`
    );

    // Validate file extension
    const allowedVideoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
    const allowedImageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const allowedExtensions =
      attachmentType === 'video' ? allowedVideoExtensions : allowedImageExtensions;

    let ext = path.extname(attachment.name).toLowerCase();
    if (!ext || !validateFileExtension(attachment.name, allowedExtensions)) {
      // If extension is invalid or missing, use default based on type
      ext = attachmentType === 'video' ? '.mp4' : '.png';
      logger.warn(
        `Invalid or missing file extension for ${attachment.name}, using default: ${ext}`
      );
    }

    // Save file to temp directory
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const filePrefix = attachmentType === 'video' ? 'video' : 'image';
    const tempFilePath = path.join(tempDir, `${filePrefix}_${Date.now()}${ext}`);
    await fs.writeFile(tempFilePath, fileBuffer);
    tempFiles.push(tempFilePath);

    // Get video duration to check limits (only for videos, admins bypass this)
    if (attachmentType === 'video' && !adminUser) {
      try {
        const metadata = await getVideoMetadata(tempFilePath);
        const duration = metadata.format.duration;

        if (duration > MAX_GIF_DURATION) {
          await interaction.editReply({
            content: `video is too long (${Math.ceil(duration)}s). maximum duration: ${MAX_GIF_DURATION}s`,
          });
          return;
        }
      } catch (error) {
        logger.warn('Failed to get video metadata:', error.message);
        // Continue anyway
      }
    } else if (attachmentType === 'video' && adminUser) {
      try {
        const metadata = await getVideoMetadata(tempFilePath);
        const duration = metadata.format.duration;
        if (duration > MAX_GIF_DURATION) {
          logger.info(
            `Video duration limit bypassed for admin (${Math.ceil(duration)}s > ${MAX_GIF_DURATION}s)`
          );
        }
      } catch {
        // Ignore metadata errors for admin bypass logging
      }
    }

    // Convert to GIF
    const gifPath = getGifPath(hash, GIF_STORAGE_PATH);

    // Only convert if the GIF doesn't already exist
    if (needsConversion) {
      if (attachmentType === 'video') {
        // Build conversion options, using provided options, user config, or defaults
        const conversionOptions = {
          width:
            options.width ??
            (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 480)),
          fps: options.fps ?? (userConfig.fps !== null ? userConfig.fps : DEFAULT_FPS),
          quality: options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
          startTime: options.startTime ?? null,
          duration: options.duration ?? null,
        };

        // Validate duration against video length if startTime and duration are provided
        if (conversionOptions.startTime !== null && conversionOptions.duration !== null) {
          try {
            const metadata = await getVideoMetadata(tempFilePath);
            const videoDuration = metadata.format.duration;
            const requestedEnd = conversionOptions.startTime + conversionOptions.duration;

            if (requestedEnd > videoDuration) {
              await interaction.editReply({
                content: `requested timeframe (${conversionOptions.startTime}s to ${requestedEnd.toFixed(1)}s) exceeds video length (${videoDuration.toFixed(1)}s).`,
              });
              return;
            }
          } catch (error) {
            logger.warn('Failed to get video metadata for timeframe validation:', error.message);
            // Continue anyway, FFmpeg will handle it
          }
        }

        await convertToGif(tempFilePath, gifPath, conversionOptions);
      } else {
        // Check if input is already a GIF
        const isGif = attachment.contentType === 'image/gif' || ext === '.gif';

        if (isGif) {
          // Get GIF dimensions to check if we need to resize
          try {
            const metadata = await getVideoMetadata(tempFilePath);
            const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
            const gifWidth = videoStream?.width;

            // Use provided width, user config, or check against limits
            const targetWidth =
              options.width ??
              (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720));

            if (
              gifWidth &&
              gifWidth <= MAX_GIF_WIDTH &&
              !options.width &&
              (userConfig.width === null || gifWidth <= userConfig.width)
            ) {
              // GIF is within size limits, copy directly without re-encoding
              logger.info(
                `Input GIF is within size limits (${gifWidth}px <= ${MAX_GIF_WIDTH}px), copying directly`
              );
              await fs.copyFile(tempFilePath, gifPath);
            } else {
              // GIF exceeds size limits or custom width requested, resize with convertImageToGif
              logger.info(
                `Input GIF exceeds size limits or custom width requested (${gifWidth || 'unknown'}px), resizing to ${targetWidth}px`
              );
              await convertImageToGif(tempFilePath, gifPath, {
                width: targetWidth,
                quality:
                  options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
              });
            }
          } catch (error) {
            // If metadata extraction fails, fall back to normal conversion
            logger.warn(`Failed to get GIF metadata, falling back to conversion: ${error.message}`);
            await convertImageToGif(tempFilePath, gifPath, {
              width:
                options.width ??
                (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720)),
              quality:
                options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
            });
          }
        } else {
          // Not a GIF, proceed with normal conversion
          await convertImageToGif(tempFilePath, gifPath, {
            width:
              options.width ??
              (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720)),
            quality:
              options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
          });
        }
      }
    } else {
      // GIF already exists, read it directly
      logger.info(`Using existing GIF (hash: ${hash}) for user ${userId}`);
    }

    // Read the generated GIF to verify it was created (or read existing one)
    const gifBuffer = await fs.readFile(gifPath);
    const originalSize = gifBuffer.length;

    // Check if optimization is requested
    let finalHash = hash;
    let _finalGifPath = gifPath;
    let optimizedSize = originalSize;
    let wasAutoOptimized = false;

    if (options.optimize) {
      // Generate hash for optimized file (include lossy level in hash for uniqueness)
      const optimizedHash = crypto.createHash('md5');
      optimizedHash.update(gifBuffer);
      optimizedHash.update('optimized');
      if (options.lossy !== undefined && options.lossy !== null) {
        optimizedHash.update(options.lossy.toString());
      }
      const optimizedHashValue = optimizedHash.digest('hex');
      const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

      // Check if optimized GIF already exists
      const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
      if (optimizedExists) {
        logger.info(
          `Optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
        );
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
      } else {
        // Optimize the GIF with specified lossy level
        const optimizeOptions =
          options.lossy !== undefined && options.lossy !== null ? { lossy: options.lossy } : {};
        logger.info(
          `Optimizing GIF: ${gifPath} -> ${optimizedGifPath}${options.lossy !== undefined && options.lossy !== null ? ` (lossy: ${options.lossy})` : ''}`
        );
        await optimizeGif(gifPath, optimizedGifPath, optimizeOptions);

        // Read optimized file and get its size
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
      }
    } else if (userConfig.autoOptimize) {
      // Auto-optimize if enabled in user config
      const optimizedHash = crypto.createHash('md5');
      optimizedHash.update(gifBuffer);
      optimizedHash.update('optimized');
      optimizedHash.update('35'); // Default lossy level
      const optimizedHashValue = optimizedHash.digest('hex');
      const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

      // Check if optimized GIF already exists
      const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
      if (optimizedExists) {
        logger.info(
          `Auto-optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
        );
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        wasAutoOptimized = true;
      } else {
        // Auto-optimize the GIF with default lossy level
        logger.info(`Auto-optimizing GIF: ${gifPath} -> ${optimizedGifPath} (lossy: 35)`);
        await optimizeGif(gifPath, optimizedGifPath, { lossy: 35 });

        // Read optimized file and get its size
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        wasAutoOptimized = true;
      }
    }

    // Generate final URL
    const gifUrl = `${CDN_BASE_URL}/${finalHash}.gif`;

    // Track recent conversion
    trackRecentConversion(userId, gifUrl);

    logger.info(
      `Successfully created GIF (hash: ${finalHash}, size: ${(optimizedSize / (1024 * 1024)).toFixed(2)}MB) for user ${userId}${options.optimize ? ' [OPTIMIZED]' : ''}${wasAutoOptimized ? ' [AUTO-OPTIMIZED]' : ''}`
    );

    // Format response message
    if (options.optimize || wasAutoOptimized) {
      const reduction = calculateSizeReduction(originalSize, optimizedSize);
      const optimizedSizeMb = formatSizeMb(optimizedSize);
      const reductionText = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
      await interaction.editReply({
        content: `gif created : ${gifUrl}\n-# gif size: ${optimizedSizeMb} (${reductionText})`,
      });
    } else {
      const gifSizeMB = (optimizedSize / (1024 * 1024)).toFixed(2);
      await interaction.editReply({
        content: `gif created : ${gifUrl}\n-# gif size: ${gifSizeMB} mb`,
      });
    }
  } catch (error) {
    logger.error(`Conversion failed for user ${userId} (${interaction.user.tag}):`, error);
    await interaction.editReply({
      content: 'an error occurred',
    });
  } finally {
    // Clean up temp files
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
  }
}

/**
 * Handle advanced context menu command with modal
 * @param {Interaction} interaction - Discord interaction
 */
async function handleAdvancedContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'convert to gif (advanced)') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated advanced conversion${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before converting another video or image.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Find video or image attachment
  const videoAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_VIDEO_TYPES.includes(att.contentType)
  );

  const imageAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_IMAGE_TYPES.includes(att.contentType)
  );

  // Check for URLs in message content if no attachments found
  let url = null;
  if (!videoAttachment && !imageAttachment && targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Determine attachment type and validate
  let attachment = null;
  let attachmentType = null;
  let preDownloadedBuffer = null;

  if (videoAttachment) {
    attachment = videoAttachment;
    attachmentType = 'video';
    logger.info(
      `Processing video: ${videoAttachment.name} (${(videoAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateVideoAttachment(videoAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (imageAttachment) {
    attachment = imageAttachment;
    attachmentType = 'image';
    logger.info(
      `Processing image: ${imageAttachment.name} (${(imageAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateImageAttachment(imageAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // For URLs, we'll need to download first to determine type, but we'll do that in modal submit
    // For now, just store the URL
    attachment = {
      url: url,
      name: 'file',
      size: 0,
      contentType: null,
    };
    attachmentType = 'unknown';
  } else {
    logger.warn(`No video or image attachment or URL found for user ${userId}`);
    await interaction.reply({
      content: 'no video or image attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Create modal
  const customId = `gif_advanced_${Date.now()}_${userId}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle('GIF Conversion Options');

  // Start time input (for videos)
  const startTimeInput = new TextInputBuilder()
    .setCustomId('start_time')
    .setLabel('Start Time (seconds)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('0')
    .setMaxLength(10);

  // Duration input
  const durationInput = new TextInputBuilder()
    .setCustomId('duration')
    .setLabel('Duration (seconds)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('max')
    .setMaxLength(10);

  // Quality input
  const qualityInput = new TextInputBuilder()
    .setCustomId('quality')
    .setLabel('Quality (low/medium/high)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('medium')
    .setMaxLength(10);

  // Width input
  const widthInput = new TextInputBuilder()
    .setCustomId('width')
    .setLabel('Width (pixels)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(attachmentType === 'video' ? '480' : '720')
    .setMaxLength(10);

  // FPS input (for videos)
  const fpsInput = new TextInputBuilder()
    .setCustomId('fps')
    .setLabel('FPS (frames per second)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('15')
    .setMaxLength(10);

  // Add inputs to modal (only show FPS for videos)
  const firstRow = new ActionRowBuilder().addComponents(startTimeInput);
  const secondRow = new ActionRowBuilder().addComponents(durationInput);
  const thirdRow = new ActionRowBuilder().addComponents(qualityInput);
  const fourthRow = new ActionRowBuilder().addComponents(widthInput);

  modal.addComponents(firstRow, secondRow, thirdRow, fourthRow);

  if (attachmentType === 'video' || attachmentType === 'unknown') {
    const fifthRow = new ActionRowBuilder().addComponents(fpsInput);
    modal.addComponents(fifthRow);
  }

  // Store attachment info in cache
  modalAttachmentCache.set(customId, {
    attachment,
    attachmentType,
    adminUser,
    preDownloadedBuffer,
    url,
    timestamp: Date.now(),
  });

  // Show modal
  await interaction.showModal(modal);
}

/**
 * Handle modal submission for advanced GIF conversion
 * @param {Interaction} interaction - Discord modal submit interaction
 */
async function handleModalSubmit(interaction) {
  if (!interaction.isModalSubmit()) {
    return;
  }

  const customId = interaction.customId;

  // Handle optimize modal
  if (customId.startsWith('optimize_modal_')) {
    const userId = interaction.user.id;

    // Retrieve cached attachment info
    const cachedData = modalAttachmentCache.get(customId);
    if (!cachedData) {
      logger.warn(`No cached data found for optimize modal ${customId} from user ${userId}`);
      await interaction.reply({
        content: 'modal session expired. please try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Clean up cache entry
    modalAttachmentCache.delete(customId);

    const { attachment, adminUser, preDownloadedBuffer } = cachedData;

    // Parse lossy level
    const lossyValue = interaction.fields.getTextInputValue('lossy_level') || null;
    let lossyLevel = null;

    if (lossyValue && lossyValue.trim() !== '') {
      const parsed = parseInt(lossyValue.trim(), 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        await interaction.reply({
          content: 'invalid lossy level. must be a number between 0 and 100.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      lossyLevel = parsed;
    }

    // Defer reply since optimization may take time
    await interaction.deferReply();

    // Process optimization
    await processOptimization(interaction, attachment, adminUser, preDownloadedBuffer, lossyLevel);
    return;
  }

  if (!customId.startsWith('gif_advanced_')) {
    return;
  }

  const userId = interaction.user.id;

  // Retrieve cached attachment info
  const cachedData = modalAttachmentCache.get(customId);
  if (!cachedData) {
    logger.warn(`No cached data found for modal ${customId} from user ${userId}`);
    await interaction.reply({
      content: 'modal session expired. please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Clean up cache entry
  modalAttachmentCache.delete(customId);

  const { attachment, attachmentType: cachedAttachmentType, adminUser, url } = cachedData;

  // Parse and validate modal fields
  const startTimeValue = interaction.fields.getTextInputValue('start_time') || null;
  const durationValue = interaction.fields.getTextInputValue('duration') || null;
  const qualityValue = interaction.fields.getTextInputValue('quality') || null;
  const widthValue = interaction.fields.getTextInputValue('width') || null;
  const fpsValue = interaction.fields.getTextInputValue('fps') || null;

  // Parse and validate options
  const options = {};

  // Start time
  if (startTimeValue && startTimeValue.trim() !== '') {
    const startTime = parseFloat(startTimeValue.trim());
    if (isNaN(startTime) || startTime < 0) {
      await interaction.reply({
        content: 'invalid start time. must be a number >= 0.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    options.startTime = startTime;
  }

  // Duration
  if (
    durationValue &&
    durationValue.trim() !== '' &&
    durationValue.trim().toLowerCase() !== 'max'
  ) {
    const duration = parseFloat(durationValue.trim());
    if (isNaN(duration) || duration <= 0) {
      await interaction.reply({
        content: 'invalid duration. must be a number > 0.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!adminUser && duration > MAX_GIF_DURATION) {
      await interaction.reply({
        content: `duration exceeds maximum (${MAX_GIF_DURATION}s).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    options.duration = duration;
  }

  // Quality
  if (qualityValue && qualityValue.trim() !== '') {
    const quality = qualityValue.trim().toLowerCase();
    if (!['low', 'medium', 'high'].includes(quality)) {
      await interaction.reply({
        content: 'invalid quality. must be one of: low, medium, high.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    options.quality = quality;
  }

  // Width
  if (widthValue && widthValue.trim() !== '') {
    const width = parseInt(widthValue.trim(), 10);
    if (isNaN(width) || width < 1 || width > 4096) {
      await interaction.reply({
        content: 'invalid width. must be a number between 1 and 4096.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (width > MAX_GIF_WIDTH) {
      await interaction.reply({
        content: `width exceeds maximum (${MAX_GIF_WIDTH}px).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    options.width = width;
  }

  // FPS
  if (fpsValue && fpsValue.trim() !== '') {
    const fps = parseFloat(fpsValue.trim());
    if (isNaN(fps) || fps < 0.1 || fps > 120) {
      await interaction.reply({
        content: 'invalid fps. must be a number between 0.1 and 120.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    options.fps = fps;
  }

  // Defer reply since conversion may take time
  await interaction.deferReply();

  // Handle URL downloads if needed
  let finalAttachment = attachment;
  let attachmentType = cachedAttachmentType;
  let preDownloadedBuffer = cachedData.preDownloadedBuffer;

  if (url && cachedAttachmentType === 'unknown') {
    try {
      // Check if URL is a Tenor GIF link and parse it
      let actualUrl = url;
      const isTenorUrl = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i.test(url);
      if (isTenorUrl) {
        logger.info(`Detected Tenor URL, parsing to extract GIF URL: ${url}`);
        try {
          actualUrl = await parseTenorUrl(url);
          logger.info(`Resolved Tenor URL to: ${actualUrl}`);
        } catch (error) {
          logger.error(`Failed to parse Tenor URL for user ${userId}:`, error);
          await interaction.editReply({
            content: error.message || 'failed to parse Tenor URL.',
          });
          return;
        }
      }

      logger.info(`Downloading file from URL: ${actualUrl}`);
      const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

      // Store the buffer to avoid double download
      preDownloadedBuffer = fileData.buffer;

      // Create a pseudo-attachment object
      finalAttachment = {
        url: actualUrl,
        name: fileData.filename,
        size: fileData.size,
        contentType: fileData.contentType,
      };

      // Determine attachment type based on content type
      logger.info(
        `File data from URL: filename=${fileData.filename}, contentType=${fileData.contentType}, size=${fileData.size}`
      );

      if (fileData.contentType && ALLOWED_VIDEO_TYPES.includes(fileData.contentType)) {
        attachmentType = 'video';
        logger.info(
          `Processing video from URL: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateVideoAttachment(finalAttachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else if (fileData.contentType && ALLOWED_IMAGE_TYPES.includes(fileData.contentType)) {
        attachmentType = 'image';
        logger.info(
          `Processing image from URL: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateImageAttachment(finalAttachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else {
        // Try to infer from filename extension as fallback
        const ext = path.extname(fileData.filename).toLowerCase();
        const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

        if (videoExts.includes(ext)) {
          logger.info(`Inferred video type from extension ${ext}, proceeding with conversion`);
          attachmentType = 'video';
          const validation = validateVideoAttachment(finalAttachment, adminUser);
          if (!validation.valid) {
            logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
            await interaction.editReply({
              content: validation.error,
            });
            return;
          }
        } else if (imageExts.includes(ext)) {
          logger.info(`Inferred image type from extension ${ext}, proceeding with conversion`);
          attachmentType = 'image';
          const validation = validateImageAttachment(finalAttachment, adminUser);
          if (!validation.valid) {
            logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
            await interaction.editReply({
              content: validation.error,
            });
            return;
          }
        } else {
          logger.warn(
            `Invalid attachment type for user ${userId}: contentType=${fileData.contentType}, filename=${fileData.filename}, ext=${ext}`
          );
          await interaction.editReply({
            content: `unsupported file format. received content-type: ${fileData.contentType || 'unknown'}, filename: ${fileData.filename}. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).`,
          });
          return;
        }
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  }

  // Process conversion with options
  await processConversion(
    interaction,
    finalAttachment,
    attachmentType,
    adminUser,
    preDownloadedBuffer,
    options
  );
}

/**
 * Handle context menu command interaction
 * @param {Interaction} interaction - Discord interaction
 */
async function handleContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'convert to gif') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated conversion${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before converting another video or image.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Find video or image attachment
  const videoAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_VIDEO_TYPES.includes(att.contentType)
  );

  const imageAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_IMAGE_TYPES.includes(att.contentType)
  );

  // Check for URLs in message content if no attachments found
  let url = null;
  if (!videoAttachment && !imageAttachment && targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Determine attachment type and validate
  let attachment = null;
  let attachmentType = null;
  let preDownloadedBuffer = null;

  if (videoAttachment) {
    attachment = videoAttachment;
    attachmentType = 'video';
    logger.info(
      `Processing video: ${videoAttachment.name} (${(videoAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateVideoAttachment(videoAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (imageAttachment) {
    attachment = imageAttachment;
    attachmentType = 'image';
    logger.info(
      `Processing image: ${imageAttachment.name} (${(imageAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateImageAttachment(imageAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if URL is a Tenor GIF link and parse it
      let actualUrl = url;
      const isTenorUrl = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i.test(url);
      if (isTenorUrl) {
        logger.info(`Detected Tenor URL, parsing to extract GIF URL: ${url}`);
        try {
          actualUrl = await parseTenorUrl(url);
          logger.info(`Resolved Tenor URL to: ${actualUrl}`);
        } catch (error) {
          logger.error(`Failed to parse Tenor URL for user ${userId}:`, error);
          await interaction.editReply({
            content: error.message || 'failed to parse Tenor URL.',
          });
          return;
        }
      }

      logger.info(`Downloading file from URL: ${actualUrl}`);
      const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

      // Store the buffer to avoid double download
      preDownloadedBuffer = fileData.buffer;

      // Create a pseudo-attachment object
      attachment = {
        url: actualUrl,
        name: fileData.filename,
        size: fileData.size,
        contentType: fileData.contentType,
      };

      // Determine attachment type based on content type
      if (fileData.contentType && ALLOWED_VIDEO_TYPES.includes(fileData.contentType)) {
        attachmentType = 'video';
        logger.info(
          `Processing video from URL: ${attachment.name} (${(attachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateVideoAttachment(attachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else if (fileData.contentType && ALLOWED_IMAGE_TYPES.includes(fileData.contentType)) {
        attachmentType = 'image';
        logger.info(
          `Processing image from URL: ${attachment.name} (${(attachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateImageAttachment(attachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else {
        logger.warn(`Invalid attachment type for user ${userId}`);
        await interaction.editReply({
          content:
            'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).',
        });
        return;
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  } else {
    logger.warn(`No video or image attachment or URL found for user ${userId}`);
    await interaction.reply({
      content: 'no video or image attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processConversion(interaction, attachment, attachmentType, adminUser, preDownloadedBuffer);
}

/**
 * Format uptime in a human-readable format
 * @param {number} milliseconds - Uptime in milliseconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Handle stats command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleStatsCommand(interaction) {
  try {
    const storageStats = await getStorageStats(GIF_STORAGE_PATH);
    const uptime = botStartTime ? Date.now() - botStartTime : 0;
    const client = interaction.client;
    const guildCount = client.guilds.cache.size;
    const userCount = await getUniqueUserCount();

    // Get user's configured FPS
    const userId = interaction.user.id;
    const userConfig = await getUserConfig(userId);
    const currentFps = userConfig.fps !== null ? userConfig.fps : DEFAULT_FPS;

    const embed = new EmbedBuilder()
      .setTitle('bot statistics')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'bot info',
          value: `uptime: \`${formatUptime(uptime)}\`\nguilds: \`${guildCount.toLocaleString()}\`\nusers: \`${userCount.toLocaleString()}\``,
          inline: false,
        },
        {
          name: 'file storage',
          value: `total gifs: \`${storageStats.totalGifs.toLocaleString()}\`\ntotal videos: \`${storageStats.totalVideos.toLocaleString()}\`\ntotal images: \`${storageStats.totalImages.toLocaleString()}\`\ndisk usage: \`${storageStats.diskUsageFormatted}\``,
          inline: false,
        },
        {
          name: 'configuration',
          value: `max width: \`${MAX_GIF_WIDTH}px\`\nmax duration: \`${MAX_GIF_DURATION}s\`\nfps: \`${currentFps}\``,
          inline: false,
        }
      );

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    await interaction.reply({
      content: 'an error occurred while fetching statistics.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Handle download context menu command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'download') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  // Load user config
  const userConfig = await getUserConfig(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated download via context menu${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before downloading another video.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Extract URLs from message content
  let url = null;
  if (targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Check if URL was found
  if (!url) {
    logger.warn(`No URL found in message for user ${userId}`);
    await interaction.reply({
      content: 'no URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await interaction.reply({
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if Cobalt is enabled
  if (!COBALT_ENABLED) {
    await interaction.reply({
      content: 'cobalt is not enabled.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if URL is from social media
  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  try {
    logger.info(`Downloading file from Cobalt: ${url}`);
    const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;
    const fileData = await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);

    // Generate hash
    let hash = generateHash(fileData.buffer);

    // Extract extension from filename
    const ext = path.extname(fileData.filename).toLowerCase() || '.mp4';

    // Detect file type
    const fileType = detectFileType(ext, fileData.contentType);

    // Determine CDN path prefix based on file type
    let cdnPath = '/gifs';
    if (fileType === 'video') {
      cdnPath = '/videos';
    } else if (fileType === 'image') {
      cdnPath = '/images';
    }

    // Check if file already exists and get appropriate path
    let exists = false;
    let filePath = null;
    if (fileType === 'gif') {
      exists = await gifExists(hash, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getGifPath(hash, GIF_STORAGE_PATH);
      }
    } else if (fileType === 'video') {
      exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getVideoPath(hash, ext, GIF_STORAGE_PATH);
      }
    } else if (fileType === 'image') {
      exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getImagePath(hash, ext, GIF_STORAGE_PATH);
      }
    }

    if (exists && filePath) {
      const filename = path.basename(filePath);
      const fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
      logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
      await interaction.editReply({
        content: `${fileType} already exists : ${fileUrl}`,
      });
    } else {
      // Save file based on type
      if (fileType === 'gif') {
        logger.info(`Saving GIF (hash: ${hash})`);
        filePath = await saveGif(fileData.buffer, hash, GIF_STORAGE_PATH);

        // Auto-optimize if enabled in user config
        if (userConfig.autoOptimize) {
          const _originalSize = fileData.buffer.length;
          const optimizedHash = crypto.createHash('md5');
          optimizedHash.update(fileData.buffer);
          optimizedHash.update('optimized');
          optimizedHash.update('35'); // Default lossy level
          const optimizedHashValue = optimizedHash.digest('hex');
          const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

          // Check if optimized GIF already exists
          const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
          if (optimizedExists) {
            logger.info(
              `Auto-optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
            );
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            cdnPath = '/gifs';
          } else {
            // Auto-optimize the GIF with default lossy level
            logger.info(
              `Auto-optimizing downloaded GIF: ${filePath} -> ${optimizedGifPath} (lossy: 35)`
            );
            await optimizeGif(filePath, optimizedGifPath, { lossy: 35 });
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            cdnPath = '/gifs';
          }
        }
      } else if (fileType === 'video') {
        logger.info(`Saving video (hash: ${hash}, extension: ${ext})`);
        filePath = await saveVideo(fileData.buffer, hash, ext, GIF_STORAGE_PATH);
      } else if (fileType === 'image') {
        logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
        filePath = await saveImage(fileData.buffer, hash, ext, GIF_STORAGE_PATH);
      }

      const filename = path.basename(filePath);
      const fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;

      // Get final file size
      const finalStats = await fs.stat(filePath);
      const finalSizeMB = (finalStats.size / (1024 * 1024)).toFixed(2);

      logger.info(
        `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}${userConfig.autoOptimize && fileType === 'gif' ? ' [AUTO-OPTIMIZED]' : ''}`
      );

      let replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${finalSizeMB} mb`;

      // Show optimization info if auto-optimized
      if (userConfig.autoOptimize && fileType === 'gif') {
        const originalSize = fileData.buffer.length;
        const reduction = calculateSizeReduction(originalSize, finalStats.size);
        const reductionText = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
        replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${formatSizeMb(finalStats.size)} (${reductionText})`;
      }

      await interaction.editReply({
        content: replyContent,
      });
    }
  } catch (error) {
    logger.error(`Download failed for user ${userId}:`, error);
    await interaction.editReply({
      content: error.message || 'an error occurred while downloading the file.',
    });
  }
}

/**
 * Handle download command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleDownloadCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  // Load user config
  const userConfig = await getUserConfig(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated download${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before downloading another video.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get URL from command options
  const url = interaction.options.getString('url');

  if (!url) {
    logger.warn(`No URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide a URL to download from.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await interaction.reply({
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if Cobalt is enabled and URL is from social media
  if (!COBALT_ENABLED) {
    await interaction.reply({
      content: 'cobalt is not enabled. please enable it to use the download command.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  try {
    logger.info(`Downloading file from Cobalt: ${url}`);
    const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;
    const fileData = await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);

    // Generate hash
    let hash = generateHash(fileData.buffer);

    // Extract extension from filename
    const ext = path.extname(fileData.filename).toLowerCase() || '.mp4';

    // Detect file type
    const fileType = detectFileType(ext, fileData.contentType);

    // Determine CDN path prefix based on file type
    let cdnPath = '/gifs';
    if (fileType === 'video') {
      cdnPath = '/videos';
    } else if (fileType === 'image') {
      cdnPath = '/images';
    }

    // Check if file already exists and get appropriate path
    let exists = false;
    let filePath = null;
    if (fileType === 'gif') {
      exists = await gifExists(hash, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getGifPath(hash, GIF_STORAGE_PATH);
      }
    } else if (fileType === 'video') {
      exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getVideoPath(hash, ext, GIF_STORAGE_PATH);
      }
    } else if (fileType === 'image') {
      exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
      if (exists) {
        filePath = getImagePath(hash, ext, GIF_STORAGE_PATH);
      }
    }

    if (exists && filePath) {
      const filename = path.basename(filePath);
      const fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
      logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
      await interaction.editReply({
        content: `${fileType} already exists : ${fileUrl}`,
      });
    } else {
      // Save file based on type
      if (fileType === 'gif') {
        logger.info(`Saving GIF (hash: ${hash})`);
        filePath = await saveGif(fileData.buffer, hash, GIF_STORAGE_PATH);

        // Auto-optimize if enabled in user config
        if (userConfig.autoOptimize) {
          const _originalSize = fileData.buffer.length;
          const optimizedHash = crypto.createHash('md5');
          optimizedHash.update(fileData.buffer);
          optimizedHash.update('optimized');
          optimizedHash.update('35'); // Default lossy level
          const optimizedHashValue = optimizedHash.digest('hex');
          const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

          // Check if optimized GIF already exists
          const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
          if (optimizedExists) {
            logger.info(
              `Auto-optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
            );
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            cdnPath = '/gifs';
          } else {
            // Auto-optimize the GIF with default lossy level
            logger.info(
              `Auto-optimizing downloaded GIF: ${filePath} -> ${optimizedGifPath} (lossy: 35)`
            );
            await optimizeGif(filePath, optimizedGifPath, { lossy: 35 });
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            cdnPath = '/gifs';
          }
        }
      } else if (fileType === 'video') {
        logger.info(`Saving video (hash: ${hash}, extension: ${ext})`);
        filePath = await saveVideo(fileData.buffer, hash, ext, GIF_STORAGE_PATH);
      } else if (fileType === 'image') {
        logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
        filePath = await saveImage(fileData.buffer, hash, ext, GIF_STORAGE_PATH);
      }

      const filename = path.basename(filePath);
      const fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;

      // Get final file size
      const finalStats = await fs.stat(filePath);
      const finalSizeMB = (finalStats.size / (1024 * 1024)).toFixed(2);

      logger.info(
        `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}${userConfig.autoOptimize && fileType === 'gif' ? ' [AUTO-OPTIMIZED]' : ''}`
      );

      let replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${finalSizeMB} mb`;

      // Show optimization info if auto-optimized
      if (userConfig.autoOptimize && fileType === 'gif') {
        const originalSize = fileData.buffer.length;
        const reduction = calculateSizeReduction(originalSize, finalStats.size);
        const reductionText = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
        replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${formatSizeMb(finalStats.size)} (${reductionText})`;
      }

      await interaction.editReply({
        content: replyContent,
      });
    }
  } catch (error) {
    logger.error(`Download failed for user ${userId}:`, error);
    await interaction.editReply({
      content: error.message || 'an error occurred while downloading the file.',
    });
  }
}

/**
 * Handle config command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleConfigCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  // Check if user is admin
  if (!adminUser) {
    logger.warn(`Non-admin user ${userId} (${interaction.user.tag}) attempted to use /config`);
    await interaction.reply({
      content: 'this command is only available to admin users.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'view') {
    try {
      const userConfig = await getUserConfig(userId);

      const embed = new EmbedBuilder()
        .setTitle('your configuration')
        .setColor(0x00ff00)
        .setDescription('current personal settings for gif conversion')
        .addFields(
          {
            name: 'fps',
            value: userConfig.fps !== null ? userConfig.fps.toString() : `default (${DEFAULT_FPS})`,
            inline: true,
          },
          {
            name: 'width',
            value: userConfig.width !== null ? userConfig.width.toString() : `default (480)`,
            inline: true,
          },
          {
            name: 'quality',
            value: userConfig.quality !== null ? userConfig.quality : 'default (medium)',
            inline: true,
          },
          {
            name: 'autoOptimize',
            value: userConfig.autoOptimize ? 'enabled' : 'disabled',
            inline: true,
          }
        )
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error(`Failed to load config for user ${userId}:`, error);
      await interaction.reply({
        content: 'failed to load your configuration.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } else if (subcommand === 'set') {
    try {
      const updates = {};
      const fps = interaction.options.getNumber('fps');
      const width = interaction.options.getNumber('width');
      const quality = interaction.options.getString('quality');
      const autoOptimize = interaction.options.getBoolean('auto_optimize');

      if (fps !== null) {
        updates.fps = fps;
      }
      if (width !== null) {
        updates.width = width;
      }
      if (quality !== null) {
        updates.quality = quality;
      }
      if (autoOptimize !== null) {
        updates.autoOptimize = autoOptimize;
      }

      if (Object.keys(updates).length === 0) {
        await interaction.reply({
          content:
            'please specify at least one setting to update (fps, width, quality, or auto_optimize).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const result = await setUserConfig(userId, updates, adminUser);

      if (!result.success) {
        await interaction.reply({
          content: `failed to update configuration: ${result.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const updatedFields = [];
      if (fps !== null) {
        updatedFields.push(`**fps**: ${fps}`);
      }
      if (width !== null) {
        updatedFields.push(`**width**: ${width}`);
      }
      if (quality !== null) {
        updatedFields.push(`**quality**: ${quality}`);
      }
      if (autoOptimize !== null) {
        updatedFields.push(`**autoOptimize**: ${autoOptimize ? 'enabled' : 'disabled'}`);
      }

      await interaction.reply({
        content: `configuration updated:\n${updatedFields.join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });

      logger.info(
        `User ${userId} (${interaction.user.tag}) updated their config: ${JSON.stringify(updates)}`
      );
    } catch (error) {
      logger.error(`Failed to update config for user ${userId}:`, error);
      await interaction.reply({
        content: 'an error occurred while updating your configuration.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

/**
 * Handle optimize context menu command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleOptimizeContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'optimize') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via context menu${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before optimizing another gif.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Find GIF attachment
  const gifAttachment = targetMessage.attachments.find(
    att => att.contentType === 'image/gif' || (att.name && att.name.toLowerCase().endsWith('.gif'))
  );

  // Check for URLs in message content if no attachment found
  let url = null;
  if (!gifAttachment && targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Determine attachment and validate it's a GIF
  let attachment = null;
  let preDownloadedBuffer = null;

  if (gifAttachment) {
    // Validate it's actually a GIF
    if (!isGifFile(gifAttachment.name, gifAttachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await interaction.reply({
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    attachment = gifAttachment;
  } else if (url) {
    // Validate URL format
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if it's a cdn.p1x.dev URL and try to use local file
      const hash = extractHashFromCdnUrl(url);
      let useLocalFile = false;
      let localFilePath = null;

      if (hash) {
        const exists = await checkLocalGif(hash, GIF_STORAGE_PATH);
        if (exists) {
          localFilePath = getGifPath(hash, GIF_STORAGE_PATH);
          useLocalFile = true;
          logger.info(`Using local file for cdn.p1x.dev URL: ${localFilePath}`);
        }
      }

      if (!useLocalFile) {
        // Download the GIF
        logger.info(`Downloading GIF from URL: ${url}`);
        const fileData = await downloadFileFromUrl(url, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await interaction.editReply({
            content: 'this command only works on gif files.',
          });
          return;
        }

        preDownloadedBuffer = fileData.buffer;

        // Create a pseudo-attachment object
        attachment = {
          url: url,
          name: fileData.filename,
          size: fileData.size,
          contentType: fileData.contentType,
        };
      } else {
        // Use local file
        const stats = await fs.stat(localFilePath);
        attachment = {
          url: url,
          name: path.basename(localFilePath),
          size: stats.size,
          contentType: 'image/gif',
        };
        preDownloadedBuffer = await fs.readFile(localFilePath);
      }
    } catch (error) {
      logger.error(`Failed to process URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to process gif from URL.',
      });
      return;
    }
  } else {
    logger.warn(`No GIF attachment or URL found for user ${userId}`);
    await interaction.reply({
      content: 'no gif attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Show modal to get lossy level
  const modal = new ModalBuilder()
    .setCustomId(`optimize_modal_${Date.now()}`)
    .setTitle('optimize gif');

  const lossyInput = new TextInputBuilder()
    .setCustomId('lossy_level')
    .setLabel('lossy level (0-100, default: 35)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('35')
    .setRequired(false)
    .setMaxLength(3);

  const actionRow = new ActionRowBuilder().addComponents(lossyInput);
  modal.addComponents(actionRow);

  // Store attachment info for modal submission
  const modalId = modal.data.custom_id;
  modalAttachmentCache.set(modalId, {
    attachment,
    attachmentType: 'gif',
    adminUser,
    preDownloadedBuffer,
    timestamp: Date.now(),
  });

  await interaction.showModal(modal);
}

/**
 * Handle optimize slash command
 * @param {Interaction} interaction - Discord interaction
 */
async function handleOptimizeCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via slash command${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before optimizing another gif.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get attachment or URL from command options
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const lossyLevel = interaction.options.getNumber('lossy');

  // Validate lossy level if provided
  if (lossyLevel !== null && (lossyLevel < 0 || lossyLevel > 100)) {
    await interaction.reply({
      content: 'lossy level must be between 0 and 100.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a gif attachment or a URL to a gif file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment && url) {
    logger.warn(`Both attachment and URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a file attachment or a URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let finalAttachment = attachment;
  let preDownloadedBuffer = null;

  // Validate attachment is a GIF
  if (attachment) {
    if (!isGifFile(attachment.name, attachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await interaction.reply({
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // If URL is provided, download the file first
  if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if it's a cdn.p1x.dev URL and try to use local file
      const hash = extractHashFromCdnUrl(url);
      let useLocalFile = false;
      let localFilePath = null;

      if (hash) {
        const exists = await checkLocalGif(hash, GIF_STORAGE_PATH);
        if (exists) {
          localFilePath = getGifPath(hash, GIF_STORAGE_PATH);
          useLocalFile = true;
          logger.info(`Using local file for cdn.p1x.dev URL: ${localFilePath}`);
        }
      }

      if (!useLocalFile) {
        // Download the GIF
        logger.info(`Downloading GIF from URL: ${url}`);
        const fileData = await downloadFileFromUrl(url, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await interaction.editReply({
            content: 'this command only works on gif files.',
          });
          return;
        }

        preDownloadedBuffer = fileData.buffer;

        // Create a pseudo-attachment object
        finalAttachment = {
          url: url,
          name: fileData.filename,
          size: fileData.size,
          contentType: fileData.contentType,
        };
      } else {
        // Use local file
        const stats = await fs.stat(localFilePath);
        finalAttachment = {
          url: url,
          name: path.basename(localFilePath),
          size: stats.size,
          contentType: 'image/gif',
        };
        preDownloadedBuffer = await fs.readFile(localFilePath);
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processOptimization(
    interaction,
    finalAttachment,
    adminUser,
    preDownloadedBuffer,
    lossyLevel
  );
}

/**
 * Process GIF optimization
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment (GIF file)
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer
 * @param {number} [lossyLevel] - Lossy compression level (0-100, default: 35)
 */
async function processOptimization(
  interaction,
  attachment,
  adminUser,
  preDownloadedBuffer = null,
  lossyLevel = null
) {
  const userId = interaction.user.id;
  const tempFiles = [];

  try {
    // Download file if not already downloaded
    let fileBuffer = preDownloadedBuffer;
    if (!fileBuffer) {
      logger.info(`Downloading GIF: ${attachment.name}`);
      fileBuffer = await downloadImage(attachment.url, adminUser);
    }

    // Generate hash for the original file
    const _originalHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const originalSize = fileBuffer.length;

    // Save original to temp directory for optimization
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const tempInputPath = path.join(tempDir, `gif_input_${Date.now()}.gif`);
    await fs.writeFile(tempInputPath, fileBuffer);
    tempFiles.push(tempInputPath);

    // Generate hash for optimized file (include lossy level in hash for uniqueness)
    const hash = crypto.createHash('md5');
    hash.update(fileBuffer);
    hash.update('optimized');
    if (lossyLevel !== null) {
      hash.update(lossyLevel.toString());
    }
    const optimizedHash = hash.digest('hex');
    const optimizedGifPath = getGifPath(optimizedHash, GIF_STORAGE_PATH);

    // Optimize the GIF with specified lossy level
    const optimizeOptions = lossyLevel !== null ? { lossy: lossyLevel } : {};
    logger.info(
      `Optimizing GIF: ${tempInputPath} -> ${optimizedGifPath}${lossyLevel !== null ? ` (lossy: ${lossyLevel})` : ''}`
    );
    await optimizeGif(tempInputPath, optimizedGifPath, optimizeOptions);

    // Read optimized file and get its size
    const optimizedBuffer = await fs.readFile(optimizedGifPath);
    const optimizedSize = optimizedBuffer.length;

    // Calculate size reduction
    const reduction = calculateSizeReduction(originalSize, optimizedSize);
    const optimizedSizeMb = formatSizeMb(optimizedSize);

    // Generate CDN URL
    const filename = path.basename(optimizedGifPath);
    const optimizedUrl = `${CDN_BASE_URL}/${filename}`;

    logger.info(
      `GIF optimization completed: ${originalSize} bytes -> ${optimizedSize} bytes (${reduction}% reduction) for user ${userId}`
    );

    // Format response message
    const reductionText = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
    await interaction.editReply({
      content: `gif optimized: ${optimizedUrl}\ngif size ${optimizedSizeMb} (${reductionText})`,
    });
  } catch (error) {
    logger.error(`GIF optimization failed for user ${userId}:`, error);
    await interaction.editReply({
      content: error.message || 'an error occurred while optimizing the gif.',
    });
  } finally {
    // Clean up temp files
    await cleanupTempFiles(tempFiles);
  }
}

/**
 * Handle recent command - show user's recent conversions
 * @param {Interaction} interaction - Discord interaction
 */
async function handleRecentCommand(interaction) {
  const userId = interaction.user.id;

  logger.info(`User ${userId} (${interaction.user.tag}) requested recent conversions`);

  const recent = getRecentConversions(userId);

  if (recent.length === 0) {
    await interaction.reply({
      content: 'you have no recent conversions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Format as list
  const recentList = recent.map((url, index) => `${index + 1}. ${url}`).join('\n');

  await interaction.reply({
    content: `your recent conversions (${recent.length}):\n${recentList}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle info command - show GIF metadata
 * @param {Interaction} interaction - Discord interaction
 */
async function handleInfoCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) requested GIF info${adminUser ? ' [ADMIN]' : ''}`
  );

  // Get attachment or URL from command options
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a gif attachment or a URL to a gif file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment && url) {
    logger.warn(`Both attachment and URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a file attachment or a URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply since downloading/processing may take time
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tempFiles = [];

  try {
    let gifPath = null;
    let fileSize = 0;

    if (attachment) {
      // Validate it's a GIF
      if (!isGifFile(attachment.name, attachment.contentType)) {
        await interaction.editReply({
          content: 'this command only works on gif files.',
        });
        return;
      }

      // Download the GIF
      logger.info(`Downloading GIF from attachment: ${attachment.name}`);
      const fileData = await downloadFileFromUrl(attachment.url, adminUser, interaction.client);
      const tempFilePath = path.join(
        GIF_STORAGE_PATH,
        'temp',
        `info_${Date.now()}_${attachment.name}`
      );
      await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
      await fs.writeFile(tempFilePath, fileData.buffer);
      tempFiles.push(tempFilePath);
      gifPath = tempFilePath;
      fileSize = fileData.buffer.length;
    } else if (url) {
      // Validate URL format
      const urlValidation = validateUrl(url);
      if (!urlValidation.valid) {
        logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
        await interaction.editReply({
          content: `invalid URL: ${urlValidation.error}`,
        });
        return;
      }

      // Check if it's a cdn.p1x.dev URL and try to use local file
      const hash = extractHashFromCdnUrl(url);
      let useLocalFile = false;

      if (hash) {
        const exists = await checkLocalGif(hash, GIF_STORAGE_PATH);
        if (exists) {
          gifPath = getGifPath(hash, GIF_STORAGE_PATH);
          useLocalFile = true;
          const stats = await fs.stat(gifPath);
          fileSize = stats.size;
          logger.info(`Using local file for cdn.p1x.dev URL: ${gifPath}`);
        }
      }

      if (!useLocalFile) {
        // Download the GIF
        logger.info(`Downloading GIF from URL: ${url}`);
        const fileData = await downloadFileFromUrl(url, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await interaction.editReply({
            content: 'this command only works on gif files.',
          });
          return;
        }

        const tempFilePath = path.join(
          GIF_STORAGE_PATH,
          'temp',
          `info_${Date.now()}_${fileData.filename}`
        );
        await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
        await fs.writeFile(tempFilePath, fileData.buffer);
        tempFiles.push(tempFilePath);
        gifPath = tempFilePath;
        fileSize = fileData.buffer.length;
      }
    }

    // Get GIF metadata
    const metadata = await getVideoMetadata(gifPath);
    const videoStream = metadata.streams?.find(s => s.codec_type === 'video');

    // Extract information
    const width = videoStream?.width || 'unknown';
    const height = videoStream?.height || 'unknown';
    const duration = metadata.format?.duration
      ? parseFloat(metadata.format.duration).toFixed(2)
      : 'unknown';
    const frameCount =
      videoStream?.nb_frames ||
      (duration !== 'unknown' && videoStream?.r_frame_rate
        ? Math.round(
            (parseFloat(duration) * parseFloat(videoStream.r_frame_rate.split('/')[0])) /
              parseFloat(videoStream.r_frame_rate.split('/')[1] || 1)
          )
        : 'unknown');
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    const fileSizeFormatted = fileSizeMB + ' mb';

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle('gif info')
      .setColor(0x00ff00)
      .addFields(
        {
          name: 'dimensions',
          value: `${width} × ${height}`,
          inline: true,
        },
        {
          name: 'file size',
          value: fileSizeFormatted,
          inline: true,
        },
        {
          name: 'duration',
          value: duration !== 'unknown' ? `${duration}s` : duration,
          inline: true,
        }
      )
      .setTimestamp();

    if (frameCount !== 'unknown') {
      embed.addFields({
        name: 'frame count',
        value: frameCount.toString(),
        inline: true,
      });
    }

    await interaction.editReply({
      embeds: [embed],
    });
  } catch (error) {
    logger.error(`Failed to get GIF info for user ${userId}:`, error);
    await interaction.editReply({
      content: error.message || 'an error occurred while getting gif info.',
    });
  } finally {
    // Clean up temp files
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
  }
}

/**
 * Handle slash command interaction
 * @param {Interaction} interaction - Discord interaction
 */
async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const commandName = interaction.commandName;

  if (commandName === 'stats') {
    await handleStatsCommand(interaction);
    return;
  }

  if (commandName === 'download') {
    await handleDownloadCommand(interaction);
    return;
  }

  if (commandName === 'config') {
    await handleConfigCommand(interaction);
    return;
  }

  if (commandName === 'optimize') {
    await handleOptimizeCommand(interaction);
    return;
  }

  if (commandName === 'info') {
    await handleInfoCommand(interaction);
    return;
  }

  if (commandName === 'recent') {
    await handleRecentCommand(interaction);
    return;
  }

  if (commandName !== 'convert') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated conversion via slash command${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before converting another video or image.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get attachment or URL from command options
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const optimize = interaction.options.getBoolean('optimize') ?? false;
  const lossy = interaction.options.getNumber('lossy');

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a video/image attachment or a URL to a video/image file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment && url) {
    logger.warn(`Both attachment and URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a file attachment or a URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let finalAttachment = attachment;
  let attachmentType = null;
  let preDownloadedBuffer = null;

  // If URL is provided, download the file first
  if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if URL is a Tenor GIF link and parse it
      let actualUrl = url;
      const isTenorUrl = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i.test(url);
      if (isTenorUrl) {
        logger.info(`Detected Tenor URL, parsing to extract GIF URL: ${url}`);
        try {
          actualUrl = await parseTenorUrl(url);
          logger.info(`Resolved Tenor URL to: ${actualUrl}`);
        } catch (error) {
          logger.error(`Failed to parse Tenor URL for user ${userId}:`, error);
          await interaction.editReply({
            content: error.message || 'failed to parse Tenor URL.',
          });
          return;
        }
      }

      logger.info(`Downloading file from URL: ${actualUrl}`);
      const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

      // Store the buffer to avoid double download
      preDownloadedBuffer = fileData.buffer;

      // Create a pseudo-attachment object
      finalAttachment = {
        url: actualUrl,
        name: fileData.filename,
        size: fileData.size,
        contentType: fileData.contentType,
      };
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  }

  // Determine attachment type and validate
  if (finalAttachment.contentType && ALLOWED_VIDEO_TYPES.includes(finalAttachment.contentType)) {
    attachmentType = 'video';
    logger.info(
      `Processing video: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateVideoAttachment(finalAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
      if (url) {
        await interaction.editReply({
          content: validation.error,
        });
      } else {
        await interaction.reply({
          content: validation.error,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  } else if (
    finalAttachment.contentType &&
    ALLOWED_IMAGE_TYPES.includes(finalAttachment.contentType)
  ) {
    attachmentType = 'image';
    logger.info(
      `Processing image: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateImageAttachment(finalAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
      if (url) {
        await interaction.editReply({
          content: validation.error,
        });
      } else {
        await interaction.reply({
          content: validation.error,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  } else {
    logger.warn(`Invalid attachment type for user ${userId}`);
    const errorMsg =
      'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).';
    if (url) {
      await interaction.editReply({
        content: errorMsg,
      });
    } else {
      await interaction.reply({
        content: errorMsg,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processConversion(
    interaction,
    finalAttachment,
    attachmentType,
    adminUser,
    preDownloadedBuffer,
    {
      optimize,
      lossy: lossy !== null ? lossy : undefined,
    }
  );
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // Required for DM support
    GatewayIntentBits.MessageContent, // Required to access attachments
  ],
});

// Track bot start time for uptime
let botStartTime = null;

// Event handlers
client.once(Events.ClientReady, async readyClient => {
  botStartTime = Date.now();
  await initializeUserTracking();
  readyClient.user.setPresence({ status: 'dnd' });
  logger.info(`bot logged in as ${readyClient.user.tag}`);
  logger.info(`gif storage: ${GIF_STORAGE_PATH}`);
  logger.info(`cdn url: ${CDN_BASE_URL}`);
});

client.on(Events.InteractionCreate, async interaction => {
  logger.debug(
    `Received interaction: ${interaction.type} from user ${interaction.user.id} (${interaction.user.tag})`
  );
  // Track user interaction
  await trackUser(interaction.user.id);
  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction);
  } else if (interaction.isMessageContextMenuCommand()) {
    // Route to appropriate handler based on command name
    if (interaction.commandName === 'convert to gif (advanced)') {
      await handleAdvancedContextMenuCommand(interaction);
    } else if (interaction.commandName === 'download') {
      await handleDownloadContextMenuCommand(interaction);
    } else if (interaction.commandName === 'optimize') {
      await handleOptimizeContextMenuCommand(interaction);
    } else {
      await handleContextMenuCommand(interaction);
    }
  } else if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  }
});

client.on(Events.Error, error => {
  logger.error('Discord error:', error);
});

// Validate configuration
try {
  // Config validation happens during import, but check here for clarity
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new ConfigurationError('Required configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Start bot
logger.info('Starting Discord bot...');
client.login(DISCORD_TOKEN).catch(error => {
  logger.error('an error occurred:', error);
  process.exit(1);
});

// Log shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
