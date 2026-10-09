import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Upload } from '@aws-sdk/lib-storage';
import { createLogger } from './logger.js';
// A leaf DB module, not the ./database.js barrel: storage.js imports this file.
import { getSetting } from './database/settings-pg.js';
import { NetworkError, ValidationError, withCause, describeCause } from './errors.js';
import { jobSignal, jobRemainingMs } from './media-file.js';
import { OUTPUT_FORMATS } from './output-formats.js';

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

// Bytes under the media prefixes: set from each full listing, raised by every upload since.
let usage = null;
export const getR2Usage = () => usage;
export function setR2Usage(bytes) {
  usage = { bytes, at: Date.now() };
}

// Soft cap on media bytes in R2. Steerable via the `r2_soft_limit_gb`
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

  if (!usage) return;
  const liveBytes = usage.bytes;
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
export async function uploadToR2(file, key, contentType, config, extraParams = {}) {
  const client = getR2Client(config);
  const { bucketName, publicDomain } = config;

  if (!bucketName || !publicDomain) {
    const error = new Error(
      `R2 config incomplete: bucketName=${bucketName}, publicDomain=${publicDomain}`
    );
    logger.error(`Failed to upload to R2 (${key}):`, error.message);
    throw error;
  }

  if (jobRemainingMs() < MIN_UPLOAD_BUDGET_MS) {
    logger.warn(
      `Skipping R2 upload of ${key}: ${Math.round(jobRemainingMs() / 1000)}s left in job`
    );
    throw withCause(
      new NetworkError('there was not enough time left to upload this file. please try again.'),
      `r2: ${Math.round(jobRemainingMs() / 1000)}s left in the job for ${(file.size / 1048576).toFixed(1)}MB`
    );
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
        CacheControl: 'public, max-age=604800, immutable',
        ...extraParams,
      },
    });

    // The upload stops at its time budget or when the job is cancelled, whichever comes first.
    const timeoutMs = Math.min(jobRemainingMs(), uploadBudgetMs(file.size));
    const signal = jobSignal(AbortSignal.timeout(timeoutMs));
    let stop;
    const result = await Promise.race([
      upload.done(),
      new Promise((_, reject) => {
        stop = () => {
          upload.abort().catch(() => {});
          reject(
            signal.reason?.name === 'TimeoutError'
              ? withCause(
                  new NetworkError('could not upload this file right now, try again shortly.'),
                  `r2: upload of ${(file.size / 1048576).toFixed(1)}MB hit its ${Math.round(timeoutMs / 1000)}s budget`
                )
              : signal.reason
          );
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }),
    ]).finally(() => signal.removeEventListener('abort', stop));

    if (result && result.ETag) {
      logger.debug(`Upload completed: ETag=${result.ETag}, Location=${result.Location || 'N/A'}`);
    }

    const publicUrl = `https://${publicDomain}/${key}`;
    logger.debug(`Uploaded to R2: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    logger.error(`Failed to upload to R2 (${key}): ${describeCause(error.cause ?? error)}`);
    logger.error(`Error details:`, error);
    if (error.$metadata) {
      logger.error(`AWS Error metadata:`, error.$metadata);
    }
    throw error;
  }
}

export function getR2PublicUrl(key, config) {
  const { publicDomain } = config;
  return `https://${publicDomain}/${key}`;
}

export const MEDIA_PREFIXES = {
  gif: 'gifs',
  video: 'videos',
  image: 'images',
  archive: 'archives',
  audio: 'audio',
};

// Random, so a link says nothing about the file and cannot be derived from it.
export function newMediaKey(type, extension) {
  const dir = MEDIA_PREFIXES[type];
  if (!dir) throw new Error(`Unknown file type: ${type}`);
  const safe = extension.replace(/[^a-zA-Z0-9.]/g, '');
  const ext = type === 'gif' ? '.gif' : safe.startsWith('.') ? safe : `.${safe}`;
  return `${dir}/${randomBytes(16).toString('hex')}${ext}`;
}

export const CONTENT_TYPES = {
  ...Object.fromEntries(
    Object.entries(OUTPUT_FORMATS).map(([ext, spec]) => [`.${ext}`, spec.mime])
  ),
  '.gif': 'image/gif',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
};
const FALLBACK_CONTENT_TYPES = { video: 'video/mp4', image: 'image/png' };

export function isR2Configured(config) {
  return Boolean(
    config.accountId && config.accessKeyId && config.secretAccessKey && config.bucketName
  );
}

// No object metadata: R2 keeps only the bytes and their content type.
export async function uploadMediaToR2(type, file, extension, config, contentType = null) {
  await assertR2Capacity(file.size);
  const key = newMediaKey(type, extension);
  const url = await uploadToR2(
    file,
    key,
    contentType ??
      CONTENT_TYPES[key.slice(key.lastIndexOf('.')).toLowerCase()] ??
      FALLBACK_CONTENT_TYPES[type],
    config
  );
  if (usage) usage.bytes += file.size;
  return url;
}

// Every object under the media prefixes, as {key, size, lastModified}.
export async function listMediaInR2(config) {
  const lists = await Promise.all(
    Object.values(MEDIA_PREFIXES).map(dir => listObjectsInR2(`${dir}/`, config))
  );
  return lists.flat();
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
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

const disclaimer = hours =>
  `-# this link will expire in ${formatTtlMessage(hours)}, please save and reupload to discord to keep forever`;

// Links only expire when the cleanup job runs.
export function formatR2UrlWithDisclaimer(url, config, ttlHours) {
  if (!config.cleanupEnabled || !extractR2KeyFromUrl(url, config)) return url;
  return `${url}\n${disclaimer(ttlHours)}`;
}

export function formatMultipleR2UrlsWithDisclaimer(urls, config, ttlHours) {
  if (!urls?.length) return '';
  const anyR2 = urls.some(url => extractR2KeyFromUrl(url, config));
  return config.cleanupEnabled && anyR2
    ? `${urls.join('\n')}\n${disclaimer(ttlHours)}`
    : urls.join('\n');
}
