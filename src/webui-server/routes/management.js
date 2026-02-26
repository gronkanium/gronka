import express from 'express';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../../utils/logger.js';
import { r2Config, loggerConfig, serverConfig } from '../../utils/config.js';
import { getAuthHeaders } from '../utils/auth.js';
import {
  getAdminUploadStats,
  getUntrackedR2Files,
  archiveAndCleanupAdminUploads,
} from '../../utils/admin-upload-cleanup.js';

const logger = createLogger('webui');
const router = express.Router();

// Rate limiter for management routes
const managementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

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

// List individual untracked R2 files (expired by maxAgeDays)
router.get('/api/management/admin-uploads/files', async (req, res) => {
  try {
    const maxAgeDays = parseInt(req.query.maxAgeDays, 10) || 3;
    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

    logger.debug(`Fetching admin upload file list (maxAgeDays: ${maxAgeDays})`);

    const untrackedFiles = await getUntrackedR2Files(r2Config);
    const expiredFiles = untrackedFiles
      .filter(file => file.lastModified && file.lastModified < cutoffDate)
      .map(file => ({
        key: file.key,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        lastModified: file.lastModified.toISOString(),
        fileType: getFileTypeFromKey(file.key),
        fileUrl: `https://${r2Config.publicDomain}/${file.key}`,
      }));

    res.json({
      success: true,
      files: expiredFiles,
      maxAgeDays,
    });
  } catch (error) {
    logger.error('Failed to list admin upload files:', error);
    res.status(500).json({
      success: false,
      error: 'failed to list admin upload files',
      message: error.message,
    });
  }
});

// Trigger cleanup of old admin uploads (archive + delete)
router.post('/api/management/admin-uploads/cleanup', express.json(), async (req, res) => {
  try {
    const maxAgeDays = parseInt(req.body.maxAgeDays, 10) || 3;
    const keys = Array.isArray(req.body.keys) ? req.body.keys : undefined;

    logger.info(
      `Starting admin upload cleanup (maxAgeDays: ${maxAgeDays}, keys: ${keys ? keys.length : 'all'})`
    );

    const result = await archiveAndCleanupAdminUploads(r2Config, maxAgeDays, { keys });

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
router.get('/api/management/admin-uploads/archive/:filename', managementLimiter, (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename format (only allow admin-uploads-archive-*.zip)
    if (!filename.match(/^admin-uploads-archive-[\w-]+\.zip$/)) {
      return res.status(400).json({
        success: false,
        error: 'invalid filename',
      });
    }

    // Get list of valid archive files from directory (whitelist approach)
    const baseDir = path.resolve(loggerConfig.logDir);
    const validFiles = fs
      .readdirSync(baseDir)
      .filter(f => f.match(/^admin-uploads-archive-[\w-]+\.zip$/));

    // Check requested file exists in whitelist
    if (!validFiles.includes(filename)) {
      return res.status(404).json({
        success: false,
        error: 'archive not found',
      });
    }

    // Build path from validated filename
    const filePath = path.join(baseDir, filename);

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

// Proxy presence update to the bot's HTTP server
router.post('/api/management/bot/status', express.json(), async (req, res) => {
  try {
    const { status, activity } = req.body;
    const botUrl = `http://127.0.0.1:${serverConfig.serverPort}/api/bot/status`;

    const response = await fetch(botUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ status, activity }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error('Failed to update bot status:', error);
    res.status(502).json({
      success: false,
      error: 'failed to reach bot process',
      message: error.message,
    });
  }
});

// Restart the bot by exiting the webui process; Docker restarts the container
router.post('/api/management/bot/restart', express.json(), (_req, res) => {
  logger.info('Bot restart requested — exiting webui process');
  res.json({ success: true });
  setTimeout(() => process.exit(0), 500);
});

function getFileTypeFromKey(key) {
  if (key.startsWith('gifs/')) return 'gif';
  if (key.startsWith('videos/')) return 'video';
  if (key.startsWith('images/')) return 'image';
  return 'unknown';
}

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
