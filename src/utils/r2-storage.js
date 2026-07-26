import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createLogger } from './logger.js';
// Import from leaf DB modules (not the ./database.js barrel) to avoid an import cycle:
// storage.js imports this file, so this file must not pull in the barrel that re-exports it.
import { getLiveBytes } from './database/temporary-uploads-pg.js';
import { getSetting } from './database/settings-pg.js';
import { ValidationError } from './errors.js';

const logger = createLogger('r2-storage');

// Soft cap on total live temporary-upload bytes in R2. Steerable via the `r2_soft_limit_gb`
// setting; 0 disables the guard. Keeps daily-peak storage (what R2 bills on) under budget.
const DEFAULT_R2_SOFT_LIMIT_GB = 9;

/**
 * Throw a curated error if uploading `incomingBytes` more would push live R2 storage past the
 * soft limit. Big files auto-expire fast (see upload-tiers.js), so this self-heals in minutes.
 * A read failure fails open (never block uploads because a settings/DB read hiccuped).
 * @param {number} incomingBytes
 */
async function assertR2Capacity(incomingBytes) {
  let limitGb = DEFAULT_R2_SOFT_LIMIT_GB;
  try {
    limitGb = parseFloat(await getSetting('r2_soft_limit_gb', String(DEFAULT_R2_SOFT_LIMIT_GB)));
  } catch (error) {
    logger.warn(`Could not read r2_soft_limit_gb, using default: ${error.message}`);
  }
  if (!(limitGb > 0)) {
    return; // Guard disabled.
  }

  let liveBytes;
  try {
    liveBytes = await getLiveBytes(Date.now());
  } catch (error) {
    logger.warn(`Could not read live R2 bytes, allowing upload: ${error.message}`);
    return;
  }

  const limitBytes = limitGb * 1024 * 1024 * 1024;
  if (liveBytes + incomingBytes > limitBytes) {
    logger.warn(
      `R2 soft limit reached: live=${(liveBytes / 1024 ** 3).toFixed(2)}GB + incoming=${(incomingBytes / 1024 ** 2).toFixed(2)}MB > ${limitGb}GB`
    );
    throw new ValidationError(
      "the bot's temporary storage is full right now - try again in a bit, or grab a shorter clip."
    );
  }
}

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

  // Reject before writing if this upload would push live storage past the soft budget.
  await assertR2Capacity(buffer.length);

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

export function getR2PublicUrl(key, config) {
  const { publicDomain } = config;
  return `https://${publicDomain}/${key}`;
}

export function getR2KeyFromHash(hash, fileType, extension) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;

  if (fileType === 'gif') {
    return `gifs/${safeHash}.gif`;
  } else if (fileType === 'video') {
    return `videos/${safeHash}${ext}`;
  } else if (fileType === 'image') {
    return `images/${safeHash}${ext}`;
  } else {
    throw new Error(`Unknown file type: ${fileType}`);
  }
}

/**
 * Upload GIF to R2
 * @param {Buffer} buffer - GIF buffer
 * @param {string} hash - BLAKE3 hash of the GIF
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
 * @param {string} hash - BLAKE3 hash of the video
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
 * @param {string} hash - BLAKE3 hash of the image
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

  const contentTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  const contentType = contentTypes[ext.toLowerCase()] || 'image/png';

  return await uploadToR2(buffer, key, contentType, config, metadata);
}

export async function gifExistsInR2(hash, config) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const key = `gifs/${safeHash}.gif`;
  return await fileExistsInR2(key, config);
}

export async function downloadGifFromR2(hash, config) {
  const client = getR2Client(config);
  const { bucketName } = config;
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const key = `gifs/${safeHash}.gif`;

  if (!bucketName) {
    throw new Error('R2 bucketName not configured');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await client.send(command);

    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    logger.info(`Downloaded GIF from R2: ${key} (${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);
    return buffer;
  } catch (error) {
    logger.error(`Failed to download GIF from R2 (${key}):`, error.message);
    throw error;
  }
}

export async function videoExistsInR2(hash, extension, config) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  const key = `videos/${safeHash}${ext}`;
  return await fileExistsInR2(key, config);
}

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

export async function deleteFromR2(key, config) {
  const client = getR2Client(config);
  const { bucketName } = config;

  if (!bucketName) {
    logger.warn('Cannot delete from R2: bucketName not configured');
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await client.send(command);
    logger.info(`Deleted file from R2: ${key}`);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      logger.debug(`File not found in R2 (already deleted?): ${key}`);
      return false;
    }
    logger.error(`Failed to delete file from R2 (${key}):`, error.message);
    throw error;
  }
}

/**
 * Extract R2 object key from public URL
 * @param {string} url - Public R2 URL (e.g., https://cdn.gronka.dev/gifs/abc123.gif)
 * @param {Object} config - R2 configuration
 * @returns {string|null} R2 object key (e.g., gifs/abc123.gif) or null if URL is not an R2 URL
 */
export function extractR2KeyFromUrl(url, config) {
  const { publicDomain } = config;
  if (!publicDomain || !url || typeof url !== 'string') {
    return null;
  }

  const r2UrlPrefix = `https://${publicDomain}/`;
  if (!url.startsWith(r2UrlPrefix)) {
    return null;
  }

  // Extract the key (everything after the domain)
  const key = url.slice(r2UrlPrefix.length);
  return key || null;
}

function formatTtlMessage(hours) {
  const ttlHours = hours || 72;
  if (ttlHours >= 24 && ttlHours % 24 === 0) {
    const days = ttlHours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  return ttlHours === 1 ? '1 hour' : `${ttlHours} hours`;
}

/**
 * Format R2 URL with disclaimer if temporary uploads are enabled
 * @param {string} url - URL to format (may be R2 URL or other URL)
 * @param {Object} config - R2 configuration
 * @param {boolean} [isAdmin=false] - Whether the user is an admin (admins get permanent uploads with no disclaimer)
 * @param {number|null} [ttlHoursOverride=null] - Actual retention for this file (tiered by size); falls back to the flat config TTL when omitted
 * @returns {string} URL with disclaimer appended if applicable, or original URL
 */
export function formatR2UrlWithDisclaimer(url, config, isAdmin = false, ttlHoursOverride = null) {
  // Return original URL if not a string or empty
  if (!url || typeof url !== 'string') {
    return url;
  }

  // Return original URL if temporary uploads are not enabled
  if (!config.tempUploadsEnabled) {
    return url;
  }

  // Skip disclaimer for admin users (they have permanent uploads)
  if (isAdmin) {
    return url;
  }

  // Check if URL is an R2 URL
  const r2Key = extractR2KeyFromUrl(url, config);
  if (!r2Key) {
    // Not an R2 URL, return as-is
    return url;
  }

  // Format URL with disclaimer
  const disclaimer = `\n-# this link will expire in ${formatTtlMessage(ttlHoursOverride ?? config.tempUploadTtlHours)}, please save and reupload to discord to keep forever`;
  return url + disclaimer;
}

export function formatMultipleR2UrlsWithDisclaimer(urls, config, isAdmin = false) {
  // Return empty string if no URLs
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return '';
  }

  // Return URLs as-is if temporary uploads are not enabled
  if (!config.tempUploadsEnabled) {
    return urls.join('\n');
  }

  // Skip disclaimer for admin users (they have permanent uploads)
  if (isAdmin) {
    return urls.join('\n');
  }

  // Filter for R2 URLs only
  const r2Urls = urls.filter(url => {
    if (!url || typeof url !== 'string') {
      return false;
    }
    const r2Key = extractR2KeyFromUrl(url, config);
    return r2Key !== null;
  });

  // If no R2 URLs, return plain URLs
  if (r2Urls.length === 0) {
    return urls.join('\n');
  }

  // Format all URLs with a single disclaimer at the end
  const disclaimer = `-# this link will expire in ${formatTtlMessage(config.tempUploadTtlHours)}, please save and reupload to discord to keep forever`;
  return urls.join('\n') + '\n' + disclaimer;
}
