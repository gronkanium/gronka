import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { r2Config } from '../../utils/config.js';
import { deleteFromR2, deleteManyFromR2, extractR2KeyFromUrl } from '../../utils/r2-storage.js';
import {
  getUserR2Media,
  getUserR2MediaCount,
  getR2UserStats,
  deleteProcessedUrl,
  deleteUserR2Media,
  getProcessedUrl,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Per-user R2 storage stats (file count + total bytes), largest first
router.get('/api/moderation/r2-users', async (req, res) => {
  try {
    const users = await getR2UserStats();
    res.json({ users });
  } catch (error) {
    logger.error('Failed to fetch R2 user stats:', error);
    res.status(500).json({
      error: 'failed to fetch r2 user stats',
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

    const records = await Promise.all(urlHashes.map(urlHash => getProcessedUrl(urlHash)));
    const keys = new Map();
    records.forEach((record, i) => {
      const r2Key = record && extractR2KeyFromUrl(record.file_url, r2Config);
      if (r2Key) keys.set(urlHashes[i], r2Key);
      else
        results.failed.push({
          urlHash: urlHashes[i],
          error: record ? 'not an r2 file' : 'record not found',
        });
    });
    const refused = new Set(await deleteManyFromR2([...keys.values()], r2Config));
    for (const [urlHash, r2Key] of keys) {
      if (refused.has(r2Key)) results.failed.push({ urlHash, error: 'r2 refused the delete' });
      else if (await deleteProcessedUrl(urlHash)) results.success.push(urlHash);
      else results.failed.push({ urlHash, error: 'database deletion failed' });
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

    await deleteFromR2(r2Key, r2Config);

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

    const keys = media.map(item => extractR2KeyFromUrl(item.file_url, r2Config)).filter(Boolean);
    const refused = await deleteManyFromR2(keys, r2Config);
    if (refused.length) {
      return res.status(502).json({
        error: 'r2 refused some deletes',
        message: `${refused.length} of ${keys.length} files could not be deleted; nothing was removed from the database, try again`,
      });
    }
    const r2Deleted = keys.length;
    const r2Failed = 0;

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
