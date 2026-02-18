/**
 * Process multiple media files from picker response
 */
import path from 'path';
import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { generateHash } from '../../utils/file-downloader.js';
import {
  gifExists,
  getGifPath,
  videoExists,
  getVideoPath,
  imageExists,
  getImagePath,
  saveGif,
  saveVideo,
  saveImage,
  detectFileType,
} from '../../utils/storage.js';
import { updateOperationStatus } from '../../utils/operations-tracker.js';
import { recordRateLimit } from '../../utils/rate-limit.js';
import { notifyCommandSuccess } from '../../utils/ntfy-notifier.js';
import { buildMetadata, getCdnPath } from './utils.js';
import { calculateUploadDestinations, reuploadToR2, sendMultipleMedia } from './upload.js';

const logger = createLogger('download:picker');

const { gifStoragePath: GIF_STORAGE_PATH, cdnBaseUrl: CDN_BASE_URL } = botConfig;

/**
 * Process multiple media files from a picker response
 * @param {Object} params - Parameters object
 * @param {Object} params.interaction - Discord interaction
 * @param {Array} params.fileData - Array of file data objects
 * @param {string} params.operationId - Operation ID
 * @param {string} params.urlHash - URL hash for caching
 * @param {string} params.userId - User ID
 * @param {string} params.username - Username
 * @param {boolean} params.adminUser - Whether user is admin
 * @returns {Promise<void>}
 */
export async function processPickerResponse({
  interaction,
  fileData,
  operationId,
  urlHash,
  userId,
  username,
  adminUser,
}) {
  logger.info(`Processing ${fileData.length} media files from picker`);

  const metadata = buildMetadata(userId, username);
  const mediaResults = [];
  let totalSize = 0;

  // First pass: calculate total size and process each file
  for (let i = 0; i < fileData.length; i++) {
    const media = fileData[i];
    totalSize += media.size;

    const result = await processPickerItem({
      media,
      index: i,
      metadata,
      userId,
    });

    mediaResults.push(result);
  }

  // Calculate upload destinations
  const shouldUploadToDiscord = calculateUploadDestinations(mediaResults);

  // Re-upload to R2 if file was saved locally but should be on R2
  for (let i = 0; i < mediaResults.length; i++) {
    if (!shouldUploadToDiscord[i] && mediaResults[i].method === 'discord') {
      const r2Url = await reuploadToR2(mediaResults[i], i, userId, username);
      if (r2Url) {
        mediaResults[i].url = r2Url;
        mediaResults[i].method = 'r2';
      }
    }
  }

  // Update operation to success
  updateOperationStatus(operationId, 'success', {
    fileSize: totalSize,
    mediaCount: mediaResults.length,
  });

  recordRateLimit(userId);

  // Send the media
  await sendMultipleMedia(
    interaction,
    mediaResults,
    shouldUploadToDiscord,
    urlHash,
    userId,
    adminUser
  );

  await notifyCommandSuccess(username, 'download', { operationId, userId });
}

/**
 * Process a single item from picker response
 * @param {Object} params - Parameters
 * @param {Object} params.media - Media item
 * @param {number} params.index - Item index
 * @param {Object} params.metadata - Upload metadata
 * @param {string} params.userId - User ID
 * @returns {Promise<Object>} Processed media result
 */
async function processPickerItem({ media, index, metadata, userId: _userId }) {
  const hash = generateHash(media.buffer);
  const ext = path.extname(media.filename).toLowerCase() || '.jpg';
  const fileType = detectFileType(ext, media.contentType);

  let filePath;
  let fileUrl;
  let exists = false;
  let method = null;

  // Check if file already exists based on type
  const existsResult = await checkFileExists(hash, ext, fileType);
  exists = existsResult.exists;
  filePath = existsResult.filePath;

  if (exists && filePath) {
    method = filePath.startsWith('http://') || filePath.startsWith('https://') ? 'r2' : 'discord';
    fileUrl = buildUrl(filePath, fileType);
    logger.info(
      `Media ${index + 1} already exists (hash: ${hash}, type: ${fileType}, method: ${method})`
    );
  } else {
    // Save the file
    logger.info(`Saving media ${index + 1} (hash: ${hash}, extension: ${ext}, type: ${fileType})`);
    const saveResult = await saveFile(media.buffer, hash, ext, fileType, metadata);
    filePath = saveResult.url;
    method = saveResult.method;
    fileUrl = buildUrl(filePath, fileType);
    logger.info(
      `Successfully saved media ${index + 1} (hash: ${hash}, type: ${fileType}, method: ${method})`
    );
  }

  return {
    url: fileUrl,
    size: media.size,
    buffer: media.buffer,
    filename: media.filename,
    hash,
    ext,
    fileType,
    method,
  };
}

/**
 * Check if a file exists in storage
 * @param {string} hash - File hash
 * @param {string} ext - File extension
 * @param {string} fileType - File type
 * @returns {Promise<{exists: boolean, filePath: string|null}>}
 */
async function checkFileExists(hash, ext, fileType) {
  if (fileType === 'video') {
    const exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
    return {
      exists,
      filePath: exists ? getVideoPath(hash, ext, GIF_STORAGE_PATH) : null,
    };
  } else if (fileType === 'image') {
    const exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
    return {
      exists,
      filePath: exists ? getImagePath(hash, ext, GIF_STORAGE_PATH) : null,
    };
  } else if (fileType === 'gif') {
    const exists = await gifExists(hash, GIF_STORAGE_PATH);
    return {
      exists,
      filePath: exists ? getGifPath(hash, GIF_STORAGE_PATH) : null,
    };
  }
  return { exists: false, filePath: null };
}

/**
 * Save a file to storage
 * @param {Buffer} buffer - File buffer
 * @param {string} hash - File hash
 * @param {string} ext - File extension
 * @param {string} fileType - File type
 * @param {Object} metadata - Upload metadata
 * @returns {Promise<{url: string, method: string, buffer: Buffer}>}
 */
async function saveFile(buffer, hash, ext, fileType, metadata) {
  if (fileType === 'video') {
    return saveVideo(buffer, hash, ext, GIF_STORAGE_PATH, metadata);
  } else if (fileType === 'image') {
    return saveImage(buffer, hash, ext, GIF_STORAGE_PATH, metadata);
  } else if (fileType === 'gif') {
    return saveGif(buffer, hash, GIF_STORAGE_PATH, metadata);
  }
  // Default to video
  return saveVideo(buffer, hash, ext, GIF_STORAGE_PATH, metadata);
}

/**
 * Build URL from file path
 * @param {string} filePath - File path (R2 URL or local)
 * @param {string} fileType - File type
 * @returns {string} Public URL
 */
function buildUrl(filePath, fileType) {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  const filename = path.basename(filePath);
  const cdnPath = getCdnPath(fileType);
  return `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
}
