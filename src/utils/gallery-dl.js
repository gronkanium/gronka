import fs from 'fs/promises';
import path from 'path';
import tmp from 'tmp';
import { spawn } from 'child_process';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { galleryDlSlots } from './concurrency.js';

const logger = createLogger('gallery-dl');

export const GALLERY_DL_SITES = [
  { name: 'Pixiv', hosts: ['pixiv.net'] },
  { name: 'DeviantArt', hosts: ['deviantart.com'] },
  { name: 'ArtStation', hosts: ['artstation.com'] },
  { name: 'Flickr', hosts: ['flickr.com'] },
  { name: 'Wallhaven', hosts: ['wallhaven.cc'] },
  { name: 'MangaDex', hosts: ['mangadex.org'] },
  { name: 'Rule34', hosts: ['rule34.xxx'] },
];

const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.png',
  '.webm',
  '.webp',
]);

const MAX_GALLERY_FILES = 25;

export function getGalleryDlSite(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return (
      GALLERY_DL_SITES.find(site =>
        site.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))
      )?.name || null
    );
  } catch {
    return null;
  }
}

function runGalleryDl(url, outputDir, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gallery-dl',
      [
        '--config-ignore',
        '--no-input',
        '--quiet',
        '--no-mtime',
        '--no-part',
        '--directory',
        outputDir,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new NetworkError('gallery download timed out'));
    }, timeout);

    child.stderr.on('data', data => {
      stderr += data.toString();
    });
    child.on('error', error => {
      clearTimeout(timeoutId);
      reject(
        error.code === 'ENOENT'
          ? new NetworkError('gallery downloads are unavailable right now')
          : new NetworkError('gallery download failed')
      );
    });
    child.on('close', code => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve();
      } else {
        logger.warn(`gallery-dl exited with code ${code}: ${stderr.slice(0, 300)}`);
        reject(new NetworkError('could not download this gallery'));
      }
    });
  });
}

async function findMediaFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMediaFiles(entryPath)));
    } else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function downloadWithGalleryDl(url, isAdminUser = false, maxSize = Infinity) {
  return galleryDlSlots.run(async () => {
    const tempDir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await runGalleryDl(url, tempDir.name);
      const files = await findMediaFiles(tempDir.name);
      if (files.length === 0) {
        throw new NetworkError('no downloadable media found in this gallery');
      }
      if (files.length > MAX_GALLERY_FILES) {
        throw new ValidationError('this gallery contains too many files to download at once');
      }

      const results = [];
      for (const filePath of files) {
        const buffer = await fs.readFile(filePath);
        if (!isAdminUser && buffer.length > maxSize) {
          throw new ValidationError('a gallery file is too large to download');
        }
        results.push({
          buffer,
          contentType: contentTypeForExtension(path.extname(filePath)),
          size: buffer.length,
          filename: path.basename(filePath),
        });
      }
      return results.length === 1 ? results[0] : results;
    } finally {
      tempDir.removeCallback();
    }
  });
}

function contentTypeForExtension(extension) {
  const ext = extension.toLowerCase();
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'video/mp4';
}

export async function isGalleryDlAvailable() {
  return new Promise(resolve => {
    const child = spawn('gallery-dl', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
