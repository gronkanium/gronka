import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { Upload } from '@aws-sdk/lib-storage';
import { createLogger } from './logger.js';
// Import from leaf DB modules (not the ./database.js barrel) to avoid an import cycle:
// storage.js imports this file, so this file must not pull in the barrel that re-exports it.
import { getLiveBytes } from './database/temporary-uploads-pg.js';
import { getSetting } from './database/settings-pg.js';
import { NetworkError, ValidationError } from './errors.js';
import { writeStream } from './media-file.js';

const logger = createLogger('r2-storage');

// A degraded Cloudflare route holds an upload open at a trickle instead of failing: 60MB took
// 16m57s on 2026-09-15, long past the 15-minute interaction token, which held a download slot
// and let the stuck-operation reaper fail everything queued behind it. Socket timeouts never
// fire on a trickle, so bound the upload on effective throughput instead.
const MIN_UPLOAD_BYTES_PER_SEC = 500 * 1024;
const MIN_UPLOAD_BUDGET_MS = 60_000;

export function uploadBudgetMs(bytes) {
  return Math.max(MIN_UPLOAD_BUDGET_MS, Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000));
}

// Soft cap on total live temporary-upload bytes in R2. Steerable via the `r2_soft_limit_gb`
// setting; 0 disables the guard. Keeps daily-peak storage (what R2 bills on) under budget.
const DEFAULT_R2_SOFT_LIMIT_GB = 9;

// Throw a curated error if uploading `incomingBytes` more would push live R2 storage past the soft limit
export async function r2SoftLimitGb() {
  return parseFloat(await getSetting('r2_soft_limit_gb', String(DEFAULT_R2_SOFT_LIMIT_GB)));
}

export async function assertR2Capacity(incomingBytes) {
  let limitGb = DEFAULT_R2_SOFT_LIMIT_GB;
  try {
    limitGb = await r2SoftLimitGb();
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

// One client per credentials, so connections are reused instead of a TLS handshake per call.
const clients = new Map();

function getR2Client(config) {
  const { accountId, accessKeyId, secretAccessKey } = config;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `R2 config incomplete: accountId=${accountId ? 'set' : 'missing'}, accessKeyId=${accessKeyId ? 'set' : 'missing'}, secretAccessKey=${secretAccessKey ? 'set' : 'missing'}`
    );
  }
  const id = `${accountId}:${accessKeyId}`;
  if (!clients.has(id)) {
    clients.set(
      id,
      new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      })
    );
  }
  return clients.get(id);
}

// Streams a media file ({path, size}) to R2 as a multipart upload; returns its public URL.
export async function uploadToR2(file, key, contentType, config, metadata = {}, extraParams = {}) {
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
    logger.debug(
      `Uploading to R2: ${key} (${contentType}, ${(file.size / (1024 * 1024)).toFixed(2)}MB) to bucket: ${bucketName}`
    );

    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: fs.createReadStream(file.path),
        ContentLength: file.size,
        ContentType: contentType,
        Metadata: metadata,
        CacheControl: 'public, max-age=604800, immutable',
        ...extraParams,
      },
    });

    let budgetTimer;
    const result = await Promise.race([
      upload.done(),
      new Promise((_, reject) => {
        budgetTimer = setTimeout(() => {
          upload.abort().catch(() => {});
          reject(new NetworkError('could not upload this file right now, try again shortly.'));
        }, uploadBudgetMs(file.size));
      }),
    ]).finally(() => clearTimeout(budgetTimer));

    if (result && result.ETag) {
      logger.debug(`Upload completed: ETag=${result.ETag}, Location=${result.Location || 'N/A'}`);
    }

    const publicUrl = `https://${publicDomain}/${key}`;
    logger.debug(`Uploaded to R2: ${publicUrl}`);
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
  } else if (fileType === 'archive') {
    return `archives/${safeHash}.zip`;
  } else if (fileType === 'audio') {
    return `audio/${safeHash}${ext}`;
  } else {
    throw new Error(`Unknown file type: ${fileType}`);
  }
}

export const CONTENT_TYPES = {
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};
const FALLBACK_CONTENT_TYPES = { video: 'video/mp4', image: 'image/png' };

export function isR2Configured(config) {
  return Boolean(
    config.accountId && config.accessKeyId && config.secretAccessKey && config.bucketName
  );
}

export async function uploadMediaToR2(type, file, hash, extension, config, metadata = {}) {
  await assertR2Capacity(file.size);
  const key = getR2KeyFromHash(hash, type, extension);
  const contentType =
    CONTENT_TYPES[key.slice(key.lastIndexOf('.')).toLowerCase()] ?? FALLBACK_CONTENT_TYPES[type];
  return await uploadToR2(file, key, contentType, config, metadata);
}

export async function mediaExistsInR2(type, hash, extension, config) {
  return await fileExistsInR2(getR2KeyFromHash(hash, type, extension), config);
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
    const file = await writeStream(response.Body, { ext: '.gif' });
    logger.debug(`Downloaded GIF from R2: ${key} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
    return { ...file, contentType: 'image/gif', filename: `${safeHash}.gif` };
  } catch (error) {
    logger.error(`Failed to download GIF from R2 (${key}):`, error.message);
    throw error;
  }
}

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
            lastModified: object.LastModified,
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  } catch (error) {
    logger.error(`Failed to list objects from R2 (prefix: ${prefix}):`, error.message);
    throw error;
  }
}

// DeleteObjects takes up to 1000 keys per call; returns the keys R2 refused.
export async function deleteManyFromR2(keys, config) {
  if (!keys.length) return [];
  const client = getR2Client(config);
  const failed = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const { Errors = [] } = await client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucketName,
        Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
      })
    );
    failed.push(...Errors.map(e => e.Key));
  }
  return failed;
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
    logger.debug(`Deleted file from R2: ${key}`);
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
