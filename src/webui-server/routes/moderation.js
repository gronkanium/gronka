import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { r2Config } from '../../utils/config.js';
import { deleteFromR2, extractR2KeyFromUrl } from '../../utils/r2-storage.js';
import {
  getUserR2Media,
  getUserR2MediaCount,
  deleteProcessedUrl,
  deleteUserR2Media,
  getProcessedUrl,
  getProcessedUrlsBatch,
  getModerationStats,
  getRecentR2Uploads,
  getR2UploadsCount,
  getUsersWithR2Uploads,
  getUsersWithR2UploadsCount,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Get moderation dashboard statistics
router.get('/api/moderation/stats', async (req, res) => {
  try {
    logger.debug('Fetching moderation stats');
    const stats = await getModerationStats();
    logger.debug('Moderation stats fetched', { stats });
    res.json(stats);
  } catch (error) {
    logger.error('Failed to fetch moderation stats:', error);
    res.status(500).json({
      error: 'failed to fetch moderation stats',
      message: error.message,
    });
  }
});

// Get recent R2 uploads across all users
router.get('/api/moderation/recent-uploads', async (req, res) => {
  try {
    const { limit = 25, offset = 0, fileType = null } = req.query;

    logger.debug(
      `Fetching recent R2 uploads (limit: ${limit}, offset: ${offset}, fileType: ${fileType})`
    );

    const uploads = await getRecentR2Uploads({
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      fileType: fileType || null,
    });

    const total = await getR2UploadsCount(fileType || null);

    logger.debug(`Found ${uploads.length} recent uploads (total: ${total})`);

    res.json({
      uploads,
      total,
    });
  } catch (error) {
    logger.error('Failed to fetch recent R2 uploads:', error);
    res.status(500).json({
      error: 'failed to fetch recent uploads',
      message: error.message,
    });
  }
});

// Get users with R2 uploads (only users who have uploaded files)
router.get('/api/moderation/users-with-uploads', async (req, res) => {
  try {
    const {
      search = null,
      sortBy = 'upload_count',
      sortDesc = 'true',
      limit = 50,
      offset = 0,
    } = req.query;

    logger.debug(
      `Fetching users with R2 uploads (search: ${search}, sortBy: ${sortBy}, sortDesc: ${sortDesc}, limit: ${limit}, offset: ${offset})`
    );

    const users = await getUsersWithR2Uploads({
      search: search || null,
      sortBy,
      sortDesc: sortDesc === 'true',
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    const total = await getUsersWithR2UploadsCount(search || null);

    logger.debug(`Found ${users.length} users with uploads (total: ${total})`);

    res.json({
      users,
      total,
    });
  } catch (error) {
    logger.error('Failed to fetch users with R2 uploads:', error);
    res.status(500).json({
      error: 'failed to fetch users with uploads',
      message: error.message,
    });
  }
});

// Get R2 media files for a user
router.get('/api/moderation/users/:userId/r2-media', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 25, offset = 0, fileType = null } = req.query;

    logger.debug(
      `Fetching R2 media for user ${userId} (limit: ${limit}, offset: ${offset}, fileType: ${fileType})`
    );

    const media = await getUserR2Media(userId, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      fileType: fileType || null,
    });

    const total = await getUserR2MediaCount(userId, fileType || null);

    logger.debug(`Found ${media.length} R2 media items (total: ${total}) for user ${userId}`);

    res.json({
      media,
      total,
    });
  } catch (error) {
    logger.error(`Failed to fetch R2 media for user ${req.params.userId}:`, error);
    res.status(500).json({
      error: 'failed to fetch r2 media',
      message: error.message,
    });
  }
});

// Bulk delete multiple R2 files (must be before the parameterized route)
router.delete('/api/moderation/files/bulk', express.json(), async (req, res) => {
  try {
    logger.debug('Bulk delete request received', {
      body: req.body,
      contentType: req.headers['content-type'],
    });

    const { urlHashes } = req.body;

    if (!urlHashes) {
      logger.error('Bulk delete: urlHashes is missing from request body', { body: req.body });
      return res.status(400).json({
        error: 'invalid request',
        message: 'urlHashes is required in request body',
      });
    }

    if (!Array.isArray(urlHashes) || urlHashes.length === 0) {
      logger.error('Bulk delete: urlHashes is not a valid array', { urlHashes });
      return res.status(400).json({
        error: 'invalid request',
        message: 'urlHashes must be a non-empty array',
      });
    }

    logger.debug(`Bulk deleting ${urlHashes.length} R2 files`, { urlHashes });

    const results = {
      success: [],
      failed: [],
    };

    // Batch-fetch all records in one query instead of N individual lookups
    const recordMap = await getProcessedUrlsBatch(urlHashes);

    for (const urlHash of urlHashes) {
      try {
        const record = recordMap.get(urlHash);
        if (!record) {
          results.failed.push({ urlHash, error: 'record not found' });
          continue;
        }

        // Check if it's an R2 URL
        const r2Key = extractR2KeyFromUrl(record.file_url, r2Config);
        if (!r2Key) {
          results.failed.push({ urlHash, error: 'not an r2 file' });
          continue;
        }

        // Delete from R2 (ignore errors if file doesn't exist)
        try {
          await deleteFromR2(r2Key, r2Config);
        } catch (r2Error) {
          logger.warn(`Failed to delete from R2 (may already be deleted): ${r2Error.message}`);
        }

        // Delete from database
        const deleted = await deleteProcessedUrl(urlHash);
        if (deleted) {
          results.success.push(urlHash);
        } else {
          results.failed.push({ urlHash, error: 'database deletion failed' });
        }
      } catch (error) {
        logger.error(`Failed to delete R2 file ${urlHash}:`, error);
        results.failed.push({ urlHash, error: error.message });
      }
    }

    logger.info(
      `Bulk delete completed: ${results.success.length} successful, ${results.failed.length} failed`
    );

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    logger.error('Failed to bulk delete R2 files:', error);
    res.status(500).json({
      error: 'failed to bulk delete files',
      message: error.message,
    });
  }
});

// Delete a single R2 file (must be after the bulk route)
router.delete('/api/moderation/files/:urlHash', express.json(), async (req, res) => {
  try {
    const { urlHash } = req.params;

    logger.debug(`Deleting R2 file with urlHash: ${urlHash}`);

    // Get the processed URL record
    const record = await getProcessedUrl(urlHash);
    if (!record) {
      return res.status(404).json({
        error: 'file not found',
        message: 'No record found for the specified urlHash',
      });
    }

    // Check if it's an R2 URL
    const r2Key = extractR2KeyFromUrl(record.file_url, r2Config);
    if (!r2Key) {
      return res.status(400).json({
        error: 'not an r2 file',
        message: 'The specified file is not stored in R2',
      });
    }

    // Delete from R2 (ignore errors if file doesn't exist)
    try {
      await deleteFromR2(r2Key, r2Config);
    } catch (r2Error) {
      logger.warn(`Failed to delete from R2 (may already be deleted): ${r2Error.message}`);
      // Continue to delete database record even if R2 deletion fails
    }

    // Delete from database
    const deleted = await deleteProcessedUrl(urlHash);
    if (!deleted) {
      return res.status(404).json({
        error: 'database record not found',
        message: 'File was deleted from R2 but database record was not found',
      });
    }

    logger.info(`Successfully deleted R2 file: ${urlHash} (${r2Key})`);

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    logger.error(`Failed to delete R2 file ${req.params.urlHash}:`, error);
    res.status(500).json({
      error: 'failed to delete file',
      message: error.message,
    });
  }
});

// Delete all R2 files for a user
router.delete('/api/moderation/users/:userId/r2-media', express.json(), async (req, res) => {
  try {
    const { userId } = req.params;

    logger.debug(`Deleting all R2 media for user ${userId}`);

    // Get all R2 media for the user
    const media = await getUserR2Media(userId, { limit: null, offset: null });
    const total = media.length;

    if (total === 0) {
      return res.json({
        success: true,
        message: 'No R2 files found for this user',
        deleted: 0,
      });
    }

    logger.info(`Deleting ${total} R2 files for user ${userId}`);

    // Delete each file from R2
    let r2Deleted = 0;
    let r2Failed = 0;
    for (const item of media) {
      try {
        const r2Key = extractR2KeyFromUrl(item.file_url, r2Config);
        if (r2Key) {
          try {
            await deleteFromR2(r2Key, r2Config);
            r2Deleted++;
          } catch (r2Error) {
            logger.warn(`Failed to delete from R2 (may already be deleted): ${r2Error.message}`);
            r2Failed++;
          }
        }
      } catch (error) {
        logger.warn(`Failed to process R2 deletion for ${item.url_hash}: ${error.message}`);
        r2Failed++;
      }
    }

    // Delete all records from database
    const dbDeleted = await deleteUserR2Media(userId);

    logger.info(
      `User R2 media deletion completed: ${dbDeleted} database records deleted, ${r2Deleted} R2 files deleted, ${r2Failed} R2 deletions failed`
    );

    res.json({
      success: true,
      message: `Deleted ${dbDeleted} R2 files for user`,
      deleted: dbDeleted,
      r2Deleted,
      r2Failed,
    });
  } catch (error) {
    logger.error(`Failed to delete all R2 media for user ${req.params.userId}:`, error);
    res.status(500).json({
      error: 'failed to delete user r2 media',
      message: error.message,
    });
  }
});

export default router;
