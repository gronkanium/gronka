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
  { name: 'nhentai', hosts: ['nhentai.net'] },
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
const MANGA_PAGE_CONCURRENCY = 4;

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

export function isMangaDexTitleUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase().replace(/^www\./, '') === 'mangadex.org' &&
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
      parsed.hostname.toLowerCase().replace(/^www\./, '') === 'mangadex.org' &&
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
      parsed.hostname.toLowerCase().replace(/^www\./, '') === 'nhentai.net' &&
      /^\/g\/\d+\/?$/i.test(parsed.pathname)
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
      { stdio: ['ignore', 'pipe', 'pipe'] }
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
    title: chapters[0]?.metadata?.manga || 'MangaDex title',
    chapters: chapters.filter(chapter => chapter.urls.length > 0),
  };
}

async function downloadMangaPages(urls, isAdminUser, maxSize) {
  const { downloadFileFromUrl } = await import('./file-downloader.js');
  if (urls.length === 0) {
    throw new NetworkError('no pages found in this chapter');
  }
  if (urls.length > MAX_GALLERY_FILES) {
    throw new ValidationError(`this chapter has more than ${MAX_GALLERY_FILES} pages`);
  }
  const results = new Array(urls.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      const fileData = await downloadFileFromUrl(urls[index], isAdminUser);
      if (!isAdminUser && fileData.size > maxSize) {
        throw new ValidationError('a manga page is too large to download');
      }
      results[index] = fileData;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MANGA_PAGE_CONCURRENCY, urls.length) }, () => worker())
  );
  return results;
}

export async function downloadWithGalleryDl(
  url,
  isAdminUser = false,
  maxSize = Infinity,
  options = {}
) {
  return galleryDlSlots.run(async () => {
    if (options.mediaUrls) {
      return downloadMangaPages(options.mediaUrls, isAdminUser, maxSize);
    }
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
