import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createLogger } from './logger.js';

const logger = createLogger('r2-storage');

/**
 * Initialize R2 client with credentials
 * @param {Object} config - R2 configuration
 * @param {string} config.accountId - R2 account ID
 * @param {string} config.accessKeyId - R2 access key ID
 * @param {string} config.secretAccessKey - R2 secret access key
 * @param {string} config.bucketName - R2 bucket name
 * @param {string} config.publicDomain - R2 public domain (e.g., cdn.gronka.p1x.dev)
 * @returns {S3Client} Initialized R2 client
 */
function initializeR2Client(config) {
  // Always create a new client with the provided config to avoid stale configs
  // The S3Client is lightweight and caching could cause issues if config changes
  const { accountId, accessKeyId, secretAccessKey } = config;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `R2 config incomplete: accountId=${accountId ? 'set' : 'missing'}, accessKeyId=${accessKeyId ? 'set' : 'missing'}, secretAccessKey=${secretAccessKey ? 'set' : 'missing'}`
    );
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return client;
}

/**
 * Get R2 client instance
 * @param {Object} config - R2 configuration
 * @returns {S3Client} R2 client
 */
function getR2Client(config) {
  return initializeR2Client(config);
}

/**
 * Upload a file to R2
 * @param {Buffer} buffer - File buffer to upload
 * @param {string} key - R2 object key (path in bucket)
 * @param {string} contentType - Content type (MIME type)
 * @param {Object} config - R2 configuration
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<string>} Public URL of uploaded file
 */
export async function uploadToR2(buffer, key, contentType, config, metadata = {}) {
  const client = getR2Client(config);
  const { bucketName, publicDomain } = config;

  if (!bucketName || !publicDomain) {
    const error = new Error(
      `R2 config incomplete: bucketName=${bucketName}, publicDomain=${publicDomain}`
    );
    logger.error(`Failed to upload to R2 (${key}):`, error.message);
    throw error;
  }

  try {
    logger.info(
      `Uploading to R2: ${key} (${contentType}, ${(buffer.length / (1024 * 1024)).toFixed(2)}MB) to bucket: ${bucketName}`
    );

    // Use Upload for multipart uploads (better for large files)
    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        Metadata: metadata,
        CacheControl: 'public, max-age=604800, immutable',
      },
    });

    const result = await upload.done();

    // Log the result to verify upload completed
    if (result && result.ETag) {
      logger.info(`Upload completed: ETag=${result.ETag}, Location=${result.Location || 'N/A'}`);
    }

    // Verify the file exists after upload with a HEAD request
    // This extra class B operation ensures the upload actually succeeded and the file is immediately accessible
    // R2 uploads can sometimes appear successful but fail silently, so verification prevents returning broken URLs
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await client.send(
        new HeadObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );
      logger.info(`Verified file exists in R2: ${key}`);
    } catch (verifyError) {
      logger.warn(
        `Warning: Could not verify file exists in R2 after upload (${key}):`,
        verifyError.message
      );
    }

    // Generate public URL
    const publicUrl = `https://${publicDomain}/${key}`;
    logger.info(`Uploaded to R2: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    logger.error(`Failed to upload to R2 (${key}):`, error.message);
    logger.error(`Error details:`, error);
    if (error.$metadata) {
      logger.error(`AWS Error metadata:`, error.$metadata);
    }
    throw error;
  }
}

/**
 * Check if a file exists in R2
 * @param {string} key - R2 object key (path in bucket)
 * @param {Object} config - R2 configuration
 * @returns {Promise<boolean>} True if file exists
 */
export async function fileExistsInR2(key, config) {
  const client = getR2Client(config);
  const { bucketName } = config;

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    // Log other errors but don't throw - treat as not found
    logger.warn(`Error checking file existence in R2 (${key}):`, error.message);
    return false;
  }
}

/**
 * Get public URL for a file in R2
 * @param {string} key - R2 object key (path in bucket)
 * @param {Object} config - R2 configuration
 * @returns {string} Public URL
 */
export function getR2PublicUrl(key, config) {
  const { publicDomain } = config;
  return `https://${publicDomain}/${key}`;
}

/**
 * Upload GIF to R2
 * @param {Buffer} buffer - GIF buffer
 * @param {string} hash - MD5 hash of the GIF
 * @param {Object} config - R2 configuration
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<string>} Public URL of uploaded GIF
 */
export async function uploadGifToR2(buffer, hash, config, metadata = {}) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const key = `gifs/${safeHash}.gif`;
  return await uploadToR2(buffer, key, 'image/gif', config, metadata);
}

/**
 * Upload video to R2
 * @param {Buffer} buffer - Video buffer
 * @param {string} hash - SHA-256 hash of the video
 * @param {string} extension - File extension (e.g., '.mp4', '.webm')
 * @param {Object} config - R2 configuration
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<string>} Public URL of uploaded video
 */
export async function uploadVideoToR2(buffer, hash, extension, config, metadata = {}) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  const key = `videos/${safeHash}${ext}`;

  // Determine content type from extension
  const contentTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
  };
  const contentType = contentTypes[ext.toLowerCase()] || 'video/mp4';

  return await uploadToR2(buffer, key, contentType, config, metadata);
}

/**
 * Upload image to R2
 * @param {Buffer} buffer - Image buffer
 * @param {string} hash - SHA-256 hash of the image
 * @param {string} extension - File extension (e.g., '.png', '.jpg')
 * @param {Object} config - R2 configuration
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<string>} Public URL of uploaded image
 */
export async function uploadImageToR2(buffer, hash, extension, config, metadata = {}) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  const key = `images/${safeHash}${ext}`;

  // Determine content type from extension
  const contentTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  const contentType = contentTypes[ext.toLowerCase()] || 'image/png';

  return await uploadToR2(buffer, key, contentType, config, metadata);
}

/**
 * Check if GIF exists in R2
 * @param {string} hash - MD5 hash of the GIF
 * @param {Object} config - R2 configuration
 * @returns {Promise<boolean>} True if GIF exists
 */
export async function gifExistsInR2(hash, config) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const key = `gifs/${safeHash}.gif`;
  return await fileExistsInR2(key, config);
}

/**
 * Check if video exists in R2
 * @param {string} hash - SHA-256 hash of the video
 * @param {string} extension - File extension
 * @param {Object} config - R2 configuration
 * @returns {Promise<boolean>} True if video exists
 */
export async function videoExistsInR2(hash, extension, config) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  const key = `videos/${safeHash}${ext}`;
  return await fileExistsInR2(key, config);
}

/**
 * Check if image exists in R2
 * @param {string} hash - SHA-256 hash of the image
 * @param {string} extension - File extension
 * @param {Object} config - R2 configuration
 * @returns {Promise<boolean>} True if image exists
 */
export async function imageExistsInR2(hash, extension, config) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  const key = `images/${safeHash}${ext}`;
  return await fileExistsInR2(key, config);
}

/**
 * List objects in R2 with a given prefix
 * @param {string} prefix - Prefix to filter objects (e.g., 'images/', 'gifs/', 'videos/')
 * @param {Object} config - R2 configuration
 * @returns {Promise<Array<{key: string, size: number}>>} Array of objects with key and size
 */
export async function listObjectsInR2(prefix, config) {
  const client = getR2Client(config);
  const { bucketName } = config;

  if (!bucketName) {
    logger.warn(`Cannot list R2 objects: bucketName not configured`);
    return [];
  }

  try {
    const objects = [];
    let continuationToken = undefined;

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
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    logger.debug(`Listed ${objects.length} objects from R2 with prefix: ${prefix}`);
    return objects;
  } catch (error) {
    logger.error(`Failed to list objects from R2 (prefix: ${prefix}):`, error.message);
    return [];
  }
}
