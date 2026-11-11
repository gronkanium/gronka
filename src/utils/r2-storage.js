import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Upload } from '@aws-sdk/lib-storage';
import { createLogger } from './logger.js';
// A leaf DB module, not the ./database.js barrel: storage.js imports this file.
import { readSetting, SETTINGS } from './settings.js';
import { AppError, NetworkError, ValidationError, withCause, describeCause } from './errors.js';
import { jobSignal, jobRemainingMs, typeForExtension } from './media-file.js';

const logger = createLogger('r2-storage');

// A degraded route trickles (60MB in 17 min) and never trips a socket timeout: bound throughput.
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

// Soft cap on media bytes in R2; 0 disables the guard. Keeps daily-peak storage (what R2 bills on) under budget.
export const r2SoftLimitGb = () => readSetting('r2_soft_limit_gb');

export async function assertR2Capacity(incomingBytes) {
  let limitGb = Number(SETTINGS.r2_soft_limit_gb.default);
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
        requestHandler: { requestTimeout: 60_000, throwOnRequestTimeout: true },
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
    throw error instanceof AppError
      ? error
      : withCause(
          new NetworkError('could not upload this file right now, try again shortly.'),
          error
        );
  }
}

export const MEDIA_PREFIXES = {
  gif: 'gifs',
  video: 'videos',
  image: 'images',
  archive: 'archives',
  audio: 'audio',
};

// Random, so a link or file name says nothing about the file and cannot be derived from it.
export const randomFileName = ext => `${randomBytes(16).toString('hex')}${ext}`;

export function randomKey(prefix, extension) {
  const safe = extension.replace(/[^a-zA-Z0-9.]/g, '');
  const ext = !safe || safe.startsWith('.') ? safe : `.${safe}`;
  return `${prefix}${randomFileName(ext)}`;
}

export function newMediaKey(type, extension) {
  const dir = MEDIA_PREFIXES[type];
  if (!dir) throw new Error(`Unknown file type: ${type}`);
  return randomKey(`${dir}/`, type === 'gif' ? '.gif' : extension);
}

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
      typeForExtension(key.slice(key.lastIndexOf('.'))) ??
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

// Deletes the expired keys of a listing; `bytes` is what the listing holds once they are gone.
export async function deleteExpired(objects, expired, config) {
  const failed = new Set(await deleteManyFromR2(expired, config));
  const gone = new Set(expired.filter(key => !failed.has(key)));
  const bytes = objects.reduce((sum, o) => sum + (gone.has(o.key) ? 0 : o.size), 0);
  return { deleted: gone.size, failed: failed.size, bytes };
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

export function r2ExpiryText(url, config, ttlHours) {
  if (!config.cleanupEnabled || !extractR2KeyFromUrl(url, config) || !(ttlHours > 0)) return null;
  return `-# this link will expire in ${formatTtlMessage(ttlHours)}, please save and reupload to discord to keep forever`;
}
