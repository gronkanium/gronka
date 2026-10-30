import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from './logger.js';
import { NetworkError, ValidationError, withCause, contentGone, timedOut } from './errors.js';
import { writeZip } from './archive.js';
import { fromPath, tempDir, jobSignal, watchDirSize } from './media-file.js';
import { maxDownloadBytes, tooLarge } from './size-limit.js';
import { mapLimit, ITEM_FANOUT } from './map-limit.js';
import { hostOf, normalizeHost, hostUnder } from './url-host.js';
import { getCookieArgs } from './ytdlp.js';
import { sitesFor } from '../core/sites.js';

const logger = createLogger('gallery-dl');

const GALLERY_DL_SITES = sitesFor('galleryDl');

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

// Past MAX_LOOSE_FILES a gallery goes out as one zip; MAX_GALLERY_FILES stops a whole profile.
const MAX_LOOSE_FILES = 25;
const MAX_GALLERY_FILES = 200;
const MAX_MANGA_IMAGES = 10;

// Turns gallery-dl's own error or warning lines (run with -w) into what the user is told.
export function galleryDlError(stderr, site, maxSize) {
  const lines = stderr.trim().split('\n').filter(Boolean);
  const line = lines.findLast(l => l.includes('][error]')) ?? lines.at(-1);
  const reason = line
    ? line.replace(/^\[[^\]]+\]\[\w+\] /, '').slice(0, 300)
    : 'no files and no output';
  const where = site ?? 'this site';
  const named = site ? `${site} ` : '';
  let error;
  if (/^NotFoundError|\b404\b|post not available/i.test(reason)) {
    error = contentGone();
  } else if (/File size larger than allowed maximum/.test(stderr)) {
    error = tooLarge(maxSize);
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
    error = new ValidationError(`this ${named}link has no image or video to download.`);
  } else {
    error = new NetworkError(`could not download this ${named}post`);
  }
  return withCause(error, `gallery-dl: ${reason}`);
}

// cobalt and yt-dlp only take Facebook video; gallery-dl reads photo pages.
export function isFacebookPostUrl(url) {
  try {
    return (
      hostOf(url) === 'facebook.com' &&
      /^\/([^/]+\/posts\/|permalink\.php|story\.php)/.test(new URL(url).pathname)
    );
  } catch {
    return false;
  }
}

export function isFacebookPhotoUrl(url) {
  try {
    const { pathname } = new URL(url);
    return (
      hostOf(url) === 'facebook.com' && /^\/(photo\.php|photo\/|[^/]+\/photos\/)/.test(pathname)
    );
  } catch {
    return false;
  }
}

export function getGalleryDlSite(url) {
  try {
    const hostname = hostOf(url);
    return GALLERY_DL_SITES.find(site => hostUnder(hostname, site.hosts))?.name || null;
  } catch {
    return null;
  }
}

function runGalleryDl(url, outputDir, maxSize, timeout = 300000) {
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
        '--filesize-max',
        String(Math.floor(maxSize)),
        '--directory',
        outputDir,
        ...getCookieArgs(url),
        // gallery-dl writes the jar back on exit, which would undo a refresh made meanwhile.
        ...['-o', 'cookies-update=false'],
        url,
      ],
      { signal: jobSignal(), stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    let overSize = false;
    const stopWatch = watchDirSize(outputDir, maxSize, () => {
      overSize = true;
      child.kill('SIGKILL');
    });
    const timeoutId = setTimeout(() => {
      stopWatch();
      child.kill('SIGKILL');
      reject(timedOut(`gallery-dl: timed out after ${timeout / 1000}s`));
    }, timeout);

    child.stderr.on('data', data => {
      stderr += data.toString();
    });
    child.on('error', error => {
      clearTimeout(timeoutId);
      stopWatch();
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
      stopWatch();
      if (overSize) {
        reject(tooLarge(maxSize, `gallery-dl: stopped at over ${maxSize} bytes on disk`));
      } else if (code === 0) {
        resolve(stderr);
      } else {
        logger.warn(`gallery-dl exited with code ${code}: ${stderr.slice(0, 300)}`);
        reject(galleryDlError(stderr, getGalleryDlSite(url), maxSize));
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
      reject(timedOut(`gallery-dl: discovery timed out after ${timeout / 1000}s`));
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

async function downloadMangaPages(urls) {
  const { downloadFileFromUrl } = await import('./file-downloader.js');
  if (urls.length === 0) {
    throw new NetworkError('no pages found in this chapter');
  }
  const results = await mapLimit(urls, ITEM_FANOUT, pageUrl => downloadFileFromUrl(pageUrl));
  if (results.length > MAX_MANGA_IMAGES) {
    return writeZip(results, 'manga-pages.zip');
  }
  return results;
}

export async function downloadWithGalleryDl(url, options = {}) {
  if (options.mediaUrls) {
    return downloadMangaPages(options.mediaUrls);
  }
  const maxSize = await maxDownloadBytes();
  const workDir = await tempDir();
  const warnings = await runGalleryDl(url, workDir, maxSize);
  const files = await findMediaFiles(workDir);
  if (files.length === 0) {
    throw galleryDlError(warnings, getGalleryDlSite(url), maxSize);
  }
  if (files.length > MAX_GALLERY_FILES) {
    throw new ValidationError(
      `this gallery has more than ${MAX_GALLERY_FILES} files, link a single post instead`
    );
  }
  const results = [];
  let total = 0;
  for (const filePath of files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const file = await fromPath(filePath, {
      contentType: contentTypeForExtension(path.extname(filePath)),
      filename: path.basename(filePath),
    });
    total += file.size;
    if (total > maxSize) throw tooLarge(maxSize, `gallery-dl: gallery totals ${total} bytes`);
    results.push(file);
  }
  if (results.length > MAX_LOOSE_FILES) {
    return writeZip(results, 'gallery.zip');
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
