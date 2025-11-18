import { Client, GatewayIntentBits, Events, MessageFlags, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { convertToGif, getVideoMetadata, convertImageToGif } from './utils/video-processor.js';
import { gifExists, getGifPath, cleanupTempFiles, getStorageStats } from './utils/storage.js';
import { createLogger } from './utils/logger.js';
import { botConfig } from './utils/config.js';
import { validateUrl, sanitizeFilename, validateFileExtension } from './utils/validation.js';
import { ConfigurationError, NetworkError, ValidationError } from './utils/errors.js';

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
} = botConfig;

// Rate limiting: userId -> last use timestamp
const rateLimit = new Map();

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

        if (response.refreshed_urls && response.refreshed_urls[0] && response.refreshed_urls[0].refreshed) {
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Referer': 'https://discord.com/',
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
      throw new NetworkError('access denied to the file URL (may be expired or require authentication)');
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
            const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
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
      const storeCacheMatch = html.match(/<script[^>]*id=["']store-cache["'][^>]*>(.*?)<\/script>/is);
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
      const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
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
      const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/is);
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
      logger.warn(`Failed to parse Tenor page HTML: ${error.message}, falling back to direct URL pattern`);
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
 */
async function processConversion(
  interaction,
  attachment,
  attachmentType,
  adminUser,
  preDownloadedBuffer = null
) {
  const userId = interaction.user.id;
  const tempFiles = [];

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
    if (exists) {
      const gifUrl = `${CDN_BASE_URL}/${hash}.gif`;
      logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
      await interaction.editReply({
        content: `gif already exists : ${gifUrl}`,
      });
      return;
    }

    logger.info(`Starting ${attachmentType} to GIF conversion (hash: ${hash})`);

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

    if (attachmentType === 'video') {
      await convertToGif(tempFilePath, gifPath, {
        width: Math.min(MAX_GIF_WIDTH, 480),
        fps: DEFAULT_FPS,
        quality: 'medium',
      });
    } else {
      // Check if input is already a GIF
      const isGif = attachment.contentType === 'image/gif' || ext === '.gif';
      
      if (isGif) {
        // Get GIF dimensions to check if we need to resize
        try {
          const metadata = await getVideoMetadata(tempFilePath);
          const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
          const gifWidth = videoStream?.width;
          
          if (gifWidth && gifWidth <= MAX_GIF_WIDTH) {
            // GIF is within size limits, copy directly without re-encoding
            logger.info(
              `Input GIF is within size limits (${gifWidth}px <= ${MAX_GIF_WIDTH}px), copying directly`
            );
            await fs.copyFile(tempFilePath, gifPath);
          } else {
            // GIF exceeds size limits, resize with convertImageToGif
            logger.info(
              `Input GIF exceeds size limits (${gifWidth || 'unknown'}px > ${MAX_GIF_WIDTH}px), resizing`
            );
            await convertImageToGif(tempFilePath, gifPath, {
              width: Math.min(MAX_GIF_WIDTH, 720),
              quality: 'medium',
            });
          }
        } catch (error) {
          // If metadata extraction fails, fall back to normal conversion
          logger.warn(`Failed to get GIF metadata, falling back to conversion: ${error.message}`);
          await convertImageToGif(tempFilePath, gifPath, {
            width: Math.min(MAX_GIF_WIDTH, 720),
            quality: 'medium',
          });
        }
      } else {
        // Not a GIF, proceed with normal conversion
        await convertImageToGif(tempFilePath, gifPath, {
          width: Math.min(MAX_GIF_WIDTH, 720),
          quality: 'medium',
        });
      }
    }

    // Read the generated GIF to verify it was created
    const gifBuffer = await fs.readFile(gifPath);

    // Generate final URL
    const gifUrl = `${CDN_BASE_URL}/${hash}.gif`;

    logger.info(
      `Successfully created GIF (hash: ${hash}, size: ${(gifBuffer.length / (1024 * 1024)).toFixed(2)}MB) for user ${userId}`
    );

    const gifSizeMB = (gifBuffer.length / (1024 * 1024)).toFixed(2);
    await interaction.editReply({
      content: `gif created : ${gifUrl}\n-# gif size: ${gifSizeMB} mb`,
    });
  } catch (error) {
    logger.error(`Conversion failed for user ${userId} (${interaction.user.tag}):`, error);
    await interaction.editReply({
      content: 'an error occured',
    });
  } finally {
    // Clean up temp files
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
  }
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
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
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
    const userCount = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

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
          name: 'gif storage',
          value: `total gifs: \`${storageStats.totalGifs.toLocaleString()}\`\ndisk usage: \`${storageStats.diskUsageFormatted}\``,
          inline: false,
        },
        {
          name: 'configuration',
          value: `max width: \`${MAX_GIF_WIDTH}px\`\nmax duration: \`${MAX_GIF_DURATION}s\`\ndefault fps: \`${DEFAULT_FPS}\``,
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
    preDownloadedBuffer
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
client.once(Events.ClientReady, readyClient => {
  botStartTime = Date.now();
  logger.info(`bot logged in as ${readyClient.user.tag}`);
  logger.info(`gif storage: ${GIF_STORAGE_PATH}`);
  logger.info(`cdn url: ${CDN_BASE_URL}`);
});

client.on(Events.InteractionCreate, async interaction => {
  logger.debug(
    `Received interaction: ${interaction.type} from user ${interaction.user.id} (${interaction.user.tag})`
  );
  if (interaction.isMessageContextMenuCommand()) {
    await handleContextMenuCommand(interaction);
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
  logger.error('an error occured:', error);
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
