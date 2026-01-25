import express from 'express';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../../utils/logger.js';
import { r2Config, loggerConfig } from '../../utils/config.js';
import {
  getAdminUploadStats,
  archiveAndCleanupAdminUploads,
} from '../../utils/admin-upload-cleanup.js';

const logger = createLogger('webui');
const router = express.Router();

// Get stats about admin uploads (untracked R2 files)
router.get('/api/management/admin-uploads/stats', async (req, res) => {
  try {
    const maxAgeDays = parseInt(req.query.maxAgeDays, 10) || 3;

    logger.debug(`Fetching admin upload stats (maxAgeDays: ${maxAgeDays})`);

    const stats = await getAdminUploadStats(r2Config, maxAgeDays);

    res.json({
      success: true,
      stats: {
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        totalSizeFormatted: formatBytes(stats.totalSize),
        expiredFiles: stats.expiredFiles,
        expiredSize: stats.expiredSize,
        expiredSizeFormatted: formatBytes(stats.expiredSize),
        maxAgeDays,
      },
    });
  } catch (error) {
    logger.error('Failed to get admin upload stats:', error);
    res.status(500).json({
      success: false,
      error: 'failed to get admin upload stats',
      message: error.message,
    });
  }
});

// Trigger cleanup of old admin uploads (archive + delete)
router.post('/api/management/admin-uploads/cleanup', express.json(), async (req, res) => {
  try {
    const maxAgeDays = parseInt(req.body.maxAgeDays, 10) || 3;

    logger.info(`Starting admin upload cleanup (maxAgeDays: ${maxAgeDays})`);

    const result = await archiveAndCleanupAdminUploads(r2Config, maxAgeDays);

    // Extract filename for download URL
    const archiveFilename = result.archivePath ? path.basename(result.archivePath) : null;
    const downloadUrl = archiveFilename
      ? `/api/management/admin-uploads/archive/${encodeURIComponent(archiveFilename)}`
      : null;

    res.json({
      success: true,
      result: {
        archived: result.archived,
        deleted: result.deleted,
        failed: result.failed,
        archivePath: result.archivePath,
        archiveFilename,
        downloadUrl,
        errors: result.errors,
      },
    });
  } catch (error) {
    logger.error('Failed to cleanup admin uploads:', error);
    res.status(500).json({
      success: false,
      error: 'failed to cleanup admin uploads',
      message: error.message,
    });
  }
});

// Download an archive file
router.get('/api/management/admin-uploads/archive/:filename', (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename format (only allow admin-uploads-archive-*.zip)
    if (!filename.match(/^admin-uploads-archive-[\w-]+\.zip$/)) {
      return res.status(400).json({
        success: false,
        error: 'invalid filename',
      });
    }

    const filePath = path.join(loggerConfig.logDir, filename);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'archive not found',
      });
    }

    // Send file for download
    res.download(filePath, filename, err => {
      if (err) {
        logger.error(`Failed to send archive ${filename}: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: 'failed to download archive',
          });
        }
      }
    });
  } catch (error) {
    logger.error('Failed to download archive:', error);
    res.status(500).json({
      success: false,
      error: 'failed to download archive',
      message: error.message,
    });
  }
});

// Bot restart placeholder (not implemented)
router.post('/api/management/bot/restart', express.json(), (req, res) => {
  logger.info('Bot restart requested (not implemented)');
  res.status(501).json({
    success: false,
    error: 'not implemented',
    message: 'Bot restart functionality is not yet implemented',
  });
});

/**
 * Format bytes to human readable string
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string (e.g., "1.5 MB")
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export default router;
