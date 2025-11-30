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
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

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

    for (const urlHash of urlHashes) {
      try {
        // Get the processed URL record
        const record = await getProcessedUrl(urlHash);
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
