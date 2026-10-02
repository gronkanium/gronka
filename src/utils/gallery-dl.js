import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError } from './errors.js';
import { writeZip } from './archive.js';
import { fromPath, tempDir, jobSignal } from './media-file.js';
import { mapLimit, ITEM_FANOUT } from './map-limit.js';
import { hostOf, normalizeHost } from './url-host.js';

const logger = createLogger('gallery-dl');

export const GALLERY_DL_SITES = [
  { name: 'DeviantArt', hosts: ['deviantart.com'] },
  { name: 'ArtStation', hosts: ['artstation.com'] },
  { name: 'Flickr', hosts: ['flickr.com'] },
  { name: 'Wallhaven', hosts: ['wallhaven.cc'] },
  { name: 'MangaDex', hosts: ['mangadex.org'] },
  { name: 'nhentai', hosts: ['nhentai.net'] },
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
const MAX_MANGA_IMAGES = 10;

export function getGalleryDlSite(url) {
  try {
    const hostname = hostOf(url);
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
      { signal: jobSignal(), stdio: ['ignore', 'pipe', 'pipe'] }
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

export function isMangaDexTitleUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      normalizeHost(parsed.hostname) === 'mangadex.org' &&
      /^\/title\/[0-9a-f-]+(?:\/[^/?#]+)?\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isMangaDexChapterUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      normalizeHost(parsed.hostname) === 'mangadex.org' &&
      /^\/chapter\/[0-9a-f-]+\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isNhentaiGalleryUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      normalizeHost(parsed.hostname) === 'nhentai.net' && /^\/g\/\d+\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function runGalleryDlJson(url, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gallery-dl',
      ['--config-ignore', '--no-input', '--quiet', '--resolve-json', '--dump-json', url],
      { signal: jobSignal(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new NetworkError('gallery discovery timed out'));
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timeoutId);
      reject(new NetworkError(`gallery discovery failed: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        logger.warn(`gallery-dl discovery exited with code ${code}: ${stderr.slice(0, 300)}`);
        reject(new NetworkError('could not inspect this manga'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new NetworkError('gallery-dl returned invalid manga data'));
      }
    });
  });
}

export async function discoverMangaDexTitle(url) {
  const messages = await runGalleryDlJson(url);
  const chapters = [];
  let current = null;
  for (const message of messages) {
    if (message[0] === 2) {
      current = { metadata: message[1], urls: [] };
      chapters.push(current);
    } else if (message[0] === 3 && current) {
      current.urls.push(message[1]);
    }
  }
  return {
    title: chapters[0]?.metadata?.manga || chapters[0]?.metadata?.title || 'MangaDex title',
    chapters: chapters.filter(chapter => chapter.urls.length > 0),
  };
}

async function downloadMangaPages(urls, maxSize) {
  const { downloadFileFromUrl } = await import('./file-downloader.js');
  if (urls.length === 0) {
    throw new NetworkError('no pages found in this chapter');
  }
  const results = await mapLimit(urls, ITEM_FANOUT, async pageUrl => {
    const fileData = await downloadFileFromUrl(pageUrl);
    if (fileData.size > maxSize) {
      throw new ValidationError('a manga page is too large to download');
    }
    return fileData;
  });
  if (results.length > MAX_MANGA_IMAGES) {
    return writeZip(results, 'manga-pages.zip');
  }
  return results;
}

export async function downloadWithGalleryDl(url, maxSize = Infinity, options = {}) {
  if (options.mediaUrls) {
    return downloadMangaPages(options.mediaUrls, maxSize);
  }
  const workDir = await tempDir();
  await runGalleryDl(url, workDir);
  const files = await findMediaFiles(workDir);
  if (files.length === 0) {
    throw new NetworkError('no downloadable media found in this gallery');
  }
  if (files.length > MAX_GALLERY_FILES) {
    throw new ValidationError('this gallery contains too many files to download at once');
  }
  const results = [];
  for (const filePath of files) {
    const file = await fromPath(filePath, {
      contentType: contentTypeForExtension(path.extname(filePath)),
      filename: path.basename(filePath),
    });
    if (file.size > maxSize) {
      throw new ValidationError('a gallery file is too large to download');
    }
    results.push(file);
  }
  return results.length === 1 ? results[0] : results;
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
