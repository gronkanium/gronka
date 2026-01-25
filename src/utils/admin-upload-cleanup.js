import { createLogger } from './logger.js';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getPostgresConnection } from './database/connection.js';
import { ensurePostgresInitialized } from './database/init.js';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { loggerConfig } from './config.js';

const logger = createLogger('admin-upload-cleanup');

/**
 * Initialize R2 client with credentials
 * @param {Object} config - R2 configuration
 * @returns {S3Client} Initialized R2 client
 */
function initializeR2Client(config) {
  const { accountId, accessKeyId, secretAccessKey } = config;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `R2 config incomplete: accountId=${accountId ? 'set' : 'missing'}, accessKeyId=${accessKeyId ? 'set' : 'missing'}, secretAccessKey=${secretAccessKey ? 'set' : 'missing'}`
    );
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * List all R2 objects with LastModified timestamps
 * @param {string} prefix - Prefix to filter objects (e.g., 'images/', 'gifs/', 'videos/')
 * @param {Object} config - R2 configuration
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>} Array of objects
 */
async function listR2ObjectsWithMetadata(prefix, config) {
  const client = initializeR2Client(config);
  const { bucketName } = config;

  if (!bucketName) {
    logger.warn('Cannot list R2 objects: bucketName not configured');
    return [];
  }

  const objects = [];
  let continuationToken = undefined;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await client.send(command);

      if (response.Contents) {
        for (const object of response.Contents) {
          objects.push({
            key: object.Key,
            size: object.Size || 0,
            lastModified: object.LastModified,
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  } catch (error) {
    logger.error(`Failed to list R2 objects (prefix: ${prefix}): ${error.message}`);
    throw error;
  }
}

/**
 * Get all R2 keys tracked in temporary_uploads table
 * @returns {Promise<Set<string>>} Set of tracked R2 keys
 */
async function getTrackedR2Keys() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    throw new Error('PostgreSQL not initialized');
  }

  try {
    const results = await sql`SELECT DISTINCT r2_key FROM temporary_uploads`;
    return new Set(results.map(row => row.r2_key));
  } catch (error) {
    logger.error(`Failed to get tracked R2 keys: ${error.message}`);
    throw error;
  }
}

/**
 * Find R2 files not tracked in temporary_uploads (admin uploads)
 * @param {Object} config - R2 configuration
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>} Untracked files
 */
export async function getUntrackedR2Files(config) {
  const prefixes = ['gifs/', 'videos/', 'images/'];
  const allObjects = [];

  // List all objects from all prefixes
  for (const prefix of prefixes) {
    try {
      const objects = await listR2ObjectsWithMetadata(prefix, config);
      allObjects.push(...objects);
    } catch (error) {
      logger.warn(`Error listing ${prefix}: ${error.message}`);
    }
  }

  // Get tracked keys
  const trackedKeys = await getTrackedR2Keys();

  // Filter to untracked files
  const untrackedFiles = allObjects.filter(obj => !trackedKeys.has(obj.key));

  logger.info(
    `Found ${untrackedFiles.length} untracked R2 files out of ${allObjects.length} total`
  );

  return untrackedFiles;
}

/**
 * Get stats about untracked admin uploads
 * @param {Object} config - R2 configuration
 * @param {number} [maxAgeDays=3] - Max age in days before files are considered for cleanup
 * @returns {Promise<{totalFiles: number, totalSize: number, expiredFiles: number, expiredSize: number}>}
 */
export async function getAdminUploadStats(config, maxAgeDays = 3) {
  const untrackedFiles = await getUntrackedR2Files(config);
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const stats = {
    totalFiles: untrackedFiles.length,
    totalSize: 0,
    expiredFiles: 0,
    expiredSize: 0,
  };

  for (const file of untrackedFiles) {
    stats.totalSize += file.size;
    if (file.lastModified && file.lastModified < cutoffDate) {
      stats.expiredFiles++;
      stats.expiredSize += file.size;
    }
  }

  return stats;
}

/**
 * Download a file from R2
 * @param {string} key - R2 object key
 * @param {Object} config - R2 configuration
 * @returns {Promise<Buffer>} File buffer
 */
async function downloadFromR2(key, config) {
  const client = initializeR2Client(config);
  const { bucketName } = config;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  const response = await client.send(command);

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Delete a file from R2
 * @param {string} key - R2 object key
 * @param {Object} config - R2 configuration
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteR2File(key, config) {
  const client = initializeR2Client(config);
  const { bucketName } = config;

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Archive and cleanup old admin uploads
 * Downloads files older than maxAgeDays, creates a zip archive, then deletes from R2
 * @param {Object} config - R2 configuration
 * @param {number} [maxAgeDays=3] - Max age in days before files are archived
 * @returns {Promise<{archived: number, deleted: number, failed: number, archivePath: string|null, errors: Array}>}
 */
export async function archiveAndCleanupAdminUploads(config, maxAgeDays = 3) {
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logsDir = loggerConfig.logDir;

  const stats = {
    archived: 0,
    deleted: 0,
    failed: 0,
    archivePath: null,
    errors: [],
  };

  // Get untracked files
  const untrackedFiles = await getUntrackedR2Files(config);

  // Filter to expired files
  const expiredFiles = untrackedFiles.filter(
    file => file.lastModified && file.lastModified < cutoffDate
  );

  if (expiredFiles.length === 0) {
    logger.info('No expired admin uploads to archive');
    return stats;
  }

  logger.info(`Found ${expiredFiles.length} expired admin uploads to archive`);

  // Ensure logs directory exists
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Create archive path
  const archivePath = path.join(logsDir, `admin-uploads-archive-${timestamp}.zip`);
  stats.archivePath = archivePath;

  // Create zip archive
  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const archiveReady = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);

  // Download and add files to archive
  for (const file of expiredFiles) {
    try {
      logger.debug(`Downloading ${file.key} for archiving`);
      const buffer = await downloadFromR2(file.key, config);
      archive.append(buffer, { name: file.key });
      stats.archived++;
    } catch (error) {
      stats.failed++;
      stats.errors.push({ key: file.key, error: error.message, phase: 'download' });
      logger.error(`Failed to download ${file.key}: ${error.message}`);
    }
  }

  // Finalize archive
  await archive.finalize();
  await archiveReady;

  logger.info(`Created archive: ${archivePath} (${stats.archived} files)`);

  // Delete archived files from R2
  for (const file of expiredFiles) {
    // Only delete if we successfully archived it
    const wasArchived = !stats.errors.some(e => e.key === file.key && e.phase === 'download');
    if (!wasArchived) {
      continue;
    }

    try {
      await deleteR2File(file.key, config);
      stats.deleted++;
      logger.debug(`Deleted ${file.key} from R2`);
    } catch (error) {
      stats.failed++;
      stats.errors.push({ key: file.key, error: error.message, phase: 'delete' });
      logger.error(`Failed to delete ${file.key}: ${error.message}`);
    }
  }

  logger.info(
    `Admin upload cleanup complete: ${stats.archived} archived, ${stats.deleted} deleted, ${stats.failed} failed`
  );

  return stats;
}
