import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError, withCause, contentGone } from './errors.js';
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

// Turns gallery-dl's own error or warning lines (run with -w) into what the user is told.
export function galleryDlError(stderr, site) {
  const lines = stderr.trim().split('\n').filter(Boolean);
  const line = lines.findLast(l => l.includes('][error]')) ?? lines.at(-1);
  const reason = line
    ? line.replace(/^\[[^\]]+\]\[\w+\] /, '').slice(0, 300)
    : 'no files and no output';
  const where = site ?? 'this site';
  let error;
  if (/^NotFoundError|\b404\b/.test(reason)) {
    error = contentGone();
  } else if (
    /AuthRequired|Authentication|Authorization|credentials|refresh-token|log ?in/i.test(stderr)
  ) {
    error = new ValidationError(`${where} only shows this to logged in accounts.`);
  } else if (/^ChallengeError/.test(reason)) {
    error = new NetworkError(`${where} is blocking downloads right now, try again later`);
  } else if (/\b429\b/.test(stderr)) {
    error = new NetworkError(
      `${where} is rate limiting downloads right now, try again in a few minutes.`
    );
  } else if (!line) {
    error = new ValidationError(`this ${where} link has no image or video to download.`);
  } else {
    error = new NetworkError(`could not download this ${where} post`);
  }
  return withCause(error, `gallery-dl: ${reason}`);
}

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
        '--warning',
        '--no-mtime',
        '--no-part',
        '--range',
        `1-${MAX_GALLERY_FILES + 1}`,
        '--directory',
        outputDir,
        url,
      ],
      { signal: jobSignal(), stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        withCause(
          new NetworkError('gallery download timed out'),
          `gallery-dl: timed out after ${timeout / 1000}s`
        )
      );
    }, timeout);

    child.stderr.on('data', data => {
      stderr += data.toString();
    });
    child.on('error', error => {
      clearTimeout(timeoutId);
      reject(
        withCause(
          error.code === 'ENOENT'
            ? new NetworkError('gallery downloads are unavailable right now')
            : new NetworkError('gallery download failed'),
          `gallery-dl: could not run: ${error.message}`
        )
      );
    });
    child.on('close', code => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stderr);
      } else {
        logger.warn(`gallery-dl exited with code ${code}: ${stderr.slice(0, 300)}`);
        reject(galleryDlError(stderr, getGalleryDlSite(url)));
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
      ['--config-ignore', '--no-input', '--warning', '--resolve-json', '--dump-json', url],
      { signal: jobSignal(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        withCause(
          new NetworkError('gallery discovery timed out'),
          `gallery-dl: discovery timed out after ${timeout / 1000}s`
        )
      );
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timeoutId);
      reject(
        withCause(
          new NetworkError(`gallery discovery failed: ${error.message}`),
          `gallery-dl: could not run: ${error.message}`
        )
      );
    });
    child.on('close', code => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        logger.warn(`gallery-dl discovery exited with code ${code}: ${stderr.slice(0, 300)}`);
        reject(galleryDlError(stderr, 'MangaDex'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(withCause(new NetworkError('could not read this manga'), error));
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
  const warnings = await runGalleryDl(url, workDir);
  const files = await findMediaFiles(workDir);
  if (files.length === 0) {
    throw galleryDlError(warnings, getGalleryDlSite(url));
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
