import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { sanitizeFilename } from './validation.js';
import { ssrfGuardedRequest } from './ssrf-guard.js';

const logger = createLogger('mega');
const MEGA_API = 'https://g.api.mega.co.nz/cs';
const MEGA_HOSTS = new Set(['mega.nz', 'www.mega.nz', 'mega.io', 'www.mega.io']);
const MEGA_FILE_LINK = /^\/(?:file\/([\w-]{8})#([\w-]{43})|#!([\w-]{8})!([\w-]{43}))$/;
const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function parseMegaUrl(url) {
  try {
    const { hostname, pathname, hash } = new URL(url);
    if (!MEGA_HOSTS.has(hostname)) return null;
    const match = (pathname + hash).match(MEGA_FILE_LINK);
    if (!match) return null;
    return { id: match[1] ?? match[3], key: Buffer.from(match[2] ?? match[4], 'base64url') };
  } catch {
    return null;
  }
}

// A file link shared without its key, which is usually posted separately.
export function keylessMegaFileId(url) {
  try {
    const { hostname, pathname, hash } = new URL(url);
    if (!MEGA_HOSTS.has(hostname)) return null;
    if (parseMegaUrl(url)) return null;
    return (
      (pathname + hash)
        .match(/^\/(?:file\/([\w-]{8})(?:#.*)?|#!([\w-]{8})!?)$/)
        ?.slice(1)
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

export function isMegaUrl(url) {
  return parseMegaUrl(url) !== null;
}

// The 256-bit link key folds into the AES key (first half XOR second) and the CTR nonce.
export function megaKeys(key) {
  const aesKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) aesKey[i] = key[i] ^ key[i + 16];
  const iv = Buffer.concat([key.subarray(16, 24), Buffer.alloc(8)]);
  return { aesKey, iv };
}

export function decryptMegaAttributes(at, aesKey) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, Buffer.alloc(16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(at, 'base64url')), decipher.final()])
    .toString('utf8')
    .replace(/\0+$/, '');
  if (!plain.startsWith('MEGA{')) throw new ValidationError('this mega link has the wrong key.');
  return JSON.parse(plain.slice(4));
}

export async function downloadFromMega(url, isAdminUser, maxSize) {
  const { id, key } = parseMegaUrl(url);
  const { aesKey, iv } = megaKeys(key);

  let info;
  try {
    const response = await axios.post(MEGA_API, [{ a: 'g', g: 1, ssl: 1, p: id }], {
      params: { id: 0 },
      timeout: 20000,
    });
    info = Array.isArray(response.data) ? response.data[0] : response.data;
  } catch (error) {
    logger.warn(`Mega API request failed: ${error.message}`);
    throw new NetworkError('failed to reach mega, try again in a bit.');
  }
  // Mega answers with a bare negative number for a missing (-9), taken-down (-16) or
  // over-quota (-17) file.
  if (typeof info === 'number' || !info?.g) {
    logger.warn(`Mega API error for ${id}: ${JSON.stringify(info)}`);
    throw new ValidationError('this mega file is unavailable or has been taken down.');
  }

  const { n: name = 'file' } = decryptMegaAttributes(info.at, aesKey);
  if (!isAdminUser && info.s > maxSize) {
    throw new ValidationError(`file is too large (max ${maxSize / (1024 * 1024)}mb)`);
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    throw new ValidationError('that mega link does not point to a video or image file.');
  }

  logger.info(`Downloading mega file ${id} (${info.s} bytes)`);
  let encrypted;
  try {
    const response = await axios.get(info.g, {
      ...ssrfGuardedRequest(),
      responseType: 'arraybuffer',
      timeout: 300000,
      maxContentLength: isAdminUser ? Infinity : maxSize,
    });
    encrypted = Buffer.from(response.data);
  } catch (error) {
    logger.warn(`Mega file download failed: ${error.message}`);
    throw new NetworkError('failed to download the mega file. it may be unavailable.');
  }

  const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, iv);
  const buffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return {
    buffer,
    contentType: MIME_BY_EXT[ext],
    size: buffer.length,
    filename: sanitizeFilename(name),
  };
}
