import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('storage');

/**
 * Get the storage path for GIFs
 * @param {string} storagePath - Base storage path from env or default
 * @returns {string} Full path to GIF storage directory
 */
function getStoragePath(storagePath) {
  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }
  // Relative path - resolve from project root
  return path.resolve(process.cwd(), storagePath);
}

/**
 * Detect file type from extension and content type
 * @param {string} extension - File extension (e.g., '.mp4', '.png', '.gif')
 * @param {string} [contentType] - Optional content type (e.g., 'video/mp4', 'image/png')
 * @returns {'gif'|'video'|'image'} File type
 */
export function detectFileType(extension, contentType = '') {
  const ext = extension.toLowerCase();

  // Check extension first
  if (ext === '.gif') {
    return 'gif';
  }

  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  if (videoExtensions.includes(ext)) {
    return 'video';
  }

  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
  if (imageExtensions.includes(ext)) {
    return 'image';
  }

  // Fall back to content type if extension is ambiguous
  if (contentType) {
    const contentTypeLower = contentType.toLowerCase();
    if (contentTypeLower.startsWith('image/gif')) {
      return 'gif';
    }
    if (contentTypeLower.startsWith('video/')) {
      return 'video';
    }
    if (contentTypeLower.startsWith('image/')) {
      return 'image';
    }
  }

  // Default to video if unknown (for backward compatibility)
  return 'video';
}

/**
 * Check if a GIF with the given hash already exists
 * @param {string} hash - MD5 hash of the video
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if GIF exists
 */
export async function gifExists(hash, storagePath) {
  try {
    const gifPath = getGifPath(hash, storagePath);
    await fs.access(gifPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the full file path for a GIF by hash
 * @param {string} hash - MD5 hash of the video
 * @param {string} storagePath - Base storage path
 * @returns {string} Full path to GIF file
 */
export function getGifPath(hash, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  return path.join(basePath, 'gifs', `${safeHash}.gif`);
}

/**
 * Save a GIF buffer to disk
 * @param {Buffer} buffer - GIF file buffer
 * @param {string} hash - MD5 hash of the video
 * @param {string} storagePath - Base storage path
 * @returns {Promise<string>} Path to saved GIF file
 */
export async function saveGif(buffer, hash, storagePath) {
  const _basePath = getStoragePath(storagePath);
  const gifPath = getGifPath(hash, storagePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(gifPath), { recursive: true });

  await fs.writeFile(gifPath, buffer);
  logger.debug(`Saved GIF: ${gifPath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  return gifPath;
}

/**
 * Clean up temporary video files
 * @param {string[]} tempFiles - Array of temporary file paths to delete
 * @returns {Promise<void>}
 */
export async function cleanupTempFiles(tempFiles) {
  logger.debug(`Cleaning up ${tempFiles.length} temporary files`);
  const deletePromises = tempFiles.map(async filePath => {
    try {
      await fs.unlink(filePath);
      logger.debug(`Deleted temp file: ${filePath}`);
    } catch (error) {
      // Ignore errors if file doesn't exist
      if (error.code !== 'ENOENT') {
        logger.error(`Failed to delete temp file ${filePath}:`, error.message);
      }
    }
  });

  await Promise.all(deletePromises);
}

/**
 * Format file size in bytes to human-readable string (MB first, then GB)
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size string (e.g., "1536 MB" or "1.5 GB")
 */
export function formatFileSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

/**
 * Get the full file path for a video by hash and extension
 * @param {string} hash - SHA-256 hash of the video
 * @param {string} extension - File extension (e.g., '.mp4', '.webm')
 * @param {string} storagePath - Base storage path
 * @returns {string} Full path to video file
 */
export function getVideoPath(hash, extension, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  // Ensure extension is safe (alphanumeric and dots only)
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  // Remove leading dot if present and add it back
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  return path.join(basePath, 'videos', `${safeHash}${ext}`);
}

/**
 * Check if a video with the given hash and extension already exists
 * @param {string} hash - SHA-256 hash of the video
 * @param {string} extension - File extension
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if video exists
 */
export async function videoExists(hash, extension, storagePath) {
  try {
    const videoPath = getVideoPath(hash, extension, storagePath);
    await fs.access(videoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a video buffer to disk
 * @param {Buffer} buffer - Video file buffer
 * @param {string} hash - SHA-256 hash of the video
 * @param {string} extension - File extension (e.g., '.mp4', '.webm')
 * @param {string} storagePath - Base storage path
 * @returns {Promise<string>} Path to saved video file
 */
export async function saveVideo(buffer, hash, extension, storagePath) {
  const _basePath = getStoragePath(storagePath);
  const videoPath = getVideoPath(hash, extension, storagePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(videoPath), { recursive: true });

  await fs.writeFile(videoPath, buffer);
  logger.debug(`Saved video: ${videoPath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  return videoPath;
}

/**
 * Get the full file path for an image by hash and extension
 * @param {string} hash - SHA-256 hash of the image
 * @param {string} extension - File extension (e.g., '.png', '.jpg')
 * @param {string} storagePath - Base storage path
 * @returns {string} Full path to image file
 */
export function getImagePath(hash, extension, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  // Ensure extension is safe (alphanumeric and dots only)
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  // Remove leading dot if present and add it back
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  return path.join(basePath, 'images', `${safeHash}${ext}`);
}

/**
 * Check if an image with the given hash and extension already exists
 * @param {string} hash - SHA-256 hash of the image
 * @param {string} extension - File extension
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if image exists
 */
export async function imageExists(hash, extension, storagePath) {
  try {
    const imagePath = getImagePath(hash, extension, storagePath);
    await fs.access(imagePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save an image buffer to disk
 * @param {Buffer} buffer - Image file buffer
 * @param {string} hash - SHA-256 hash of the image
 * @param {string} extension - File extension (e.g., '.png', '.jpg')
 * @param {string} storagePath - Base storage path
 * @returns {Promise<string>} Path to saved image file
 */
export async function saveImage(buffer, hash, extension, storagePath) {
  const _basePath = getStoragePath(storagePath);
  const imagePath = getImagePath(hash, extension, storagePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(imagePath), { recursive: true });

  await fs.writeFile(imagePath, buffer);
  logger.debug(`Saved image: ${imagePath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  return imagePath;
}

/**
 * Get storage statistics
 * @param {string} storagePath - Base storage path
 * @returns {Promise<{totalGifs: number, totalVideos: number, totalImages: number, diskUsageBytes: number, diskUsageFormatted: string, gifsDiskUsageBytes: number, gifsDiskUsageFormatted: string, videosDiskUsageBytes: number, videosDiskUsageFormatted: string, imagesDiskUsageBytes: number, imagesDiskUsageFormatted: string}>}
 */
export async function getStorageStats(storagePath) {
  try {
    logger.debug(`Getting storage stats for: ${storagePath}`);
    const basePath = getStoragePath(storagePath);

    let totalGifs = 0;
    let totalVideos = 0;
    let totalImages = 0;
    let totalSize = 0;
    let gifsSize = 0;
    let videosSize = 0;
    let imagesSize = 0;

    // Scan gifs subdirectory
    try {
      const gifsPath = path.join(basePath, 'gifs');
      const gifFiles = await fs.readdir(gifsPath);
      const gifFilesOnly = gifFiles.filter(f => f.endsWith('.gif'));
      totalGifs = gifFilesOnly.length;

      for (const file of gifFilesOnly) {
        try {
          const filePath = path.join(gifsPath, file);
          const stats = await fs.stat(filePath);
          const fileSize = stats.size;
          gifsSize += fileSize;
          totalSize += fileSize;
        } catch (error) {
          logger.warn(`Failed to stat GIF file ${file}:`, error.message);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to read gifs directory:`, error.message);
      }
    }

    // Scan videos subdirectory
    try {
      const videosPath = path.join(basePath, 'videos');
      const videoFiles = await fs.readdir(videosPath);
      const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
      const videoFilesOnly = videoFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return videoExtensions.includes(ext);
      });
      totalVideos = videoFilesOnly.length;

      for (const file of videoFilesOnly) {
        try {
          const filePath = path.join(videosPath, file);
          const stats = await fs.stat(filePath);
          const fileSize = stats.size;
          videosSize += fileSize;
          totalSize += fileSize;
        } catch (error) {
          logger.warn(`Failed to stat video file ${file}:`, error.message);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to read videos directory:`, error.message);
      }
    }

    // Scan images subdirectory
    try {
      const imagesPath = path.join(basePath, 'images');
      const imageFiles = await fs.readdir(imagesPath);
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
      const imageFilesOnly = imageFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return imageExtensions.includes(ext);
      });
      totalImages = imageFilesOnly.length;

      for (const file of imageFilesOnly) {
        try {
          const filePath = path.join(imagesPath, file);
          const stats = await fs.stat(filePath);
          const fileSize = stats.size;
          imagesSize += fileSize;
          totalSize += fileSize;
        } catch (error) {
          logger.warn(`Failed to stat image file ${file}:`, error.message);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to read images directory:`, error.message);
      }
    }

    const stats = {
      totalGifs,
      totalVideos,
      totalImages,
      diskUsageBytes: totalSize,
      diskUsageFormatted: formatFileSize(totalSize),
      gifsDiskUsageBytes: gifsSize,
      gifsDiskUsageFormatted: formatFileSize(gifsSize),
      videosDiskUsageBytes: videosSize,
      videosDiskUsageFormatted: formatFileSize(videosSize),
      imagesDiskUsageBytes: imagesSize,
      imagesDiskUsageFormatted: formatFileSize(imagesSize),
    };

    logger.debug(
      `Storage stats: ${stats.totalGifs} GIFs, ${stats.totalVideos} videos, ${stats.totalImages} images, ${stats.diskUsageFormatted}`
    );
    return stats;
  } catch (error) {
    logger.error(`Failed to get storage stats:`, error);
    return {
      totalGifs: 0,
      totalVideos: 0,
      totalImages: 0,
      diskUsageBytes: 0,
      diskUsageFormatted: '0.00 MB',
      gifsDiskUsageBytes: 0,
      gifsDiskUsageFormatted: '0.00 MB',
      videosDiskUsageBytes: 0,
      videosDiskUsageFormatted: '0.00 MB',
      imagesDiskUsageBytes: 0,
      imagesDiskUsageFormatted: '0.00 MB',
    };
  }
}
