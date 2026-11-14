import { createLogger } from './logger.js';
import { ValidationError, describeCause, rootCause } from './errors.js';
import { hostOf, hostUnder } from './url-host.js';
import { jobSignal } from './media-file.js';
import { maxDownloadBytes } from './size-limit.js';
import { formatFileSize } from './storage.js';
import { writeZip } from './archive.js';
import { mapLimit, ITEM_FANOUT } from './map-limit.js';
import { recordFailure } from './failures.js';
import { ytdlpEntries } from './ytdlp.js';
import { spotifyTracks } from './spotify.js';
import { appleAlbumTracks } from './apple-music.js';

const logger = createLogger('collections');

// Videos fill one Discord message; an album goes out as one zip.
const KINDS = { video: { max: 10, noun: 'videos' }, audio: { max: 25, noun: 'tracks' } };

// A watch?v=&list= link means that one video; only the playlist page is the list. Profiles never are.
export function collectionOf(url) {
  const parsed = URL.parse(url);
  const host = hostOf(url);
  if (!parsed || !host) return null;
  const { pathname, searchParams } = parsed;
  if (hostUnder(host, 'youtube.com') && pathname === '/playlist' && searchParams.get('list')) {
    return { kind: 'video', list: max => ytdlpEntries(url, max) };
  }
  if (hostUnder(host, 'soundcloud.com') && /^\/[^/]+\/sets\/[^/]+\/?$/.test(pathname)) {
    return { kind: 'audio', list: max => ytdlpEntries(url, max) };
  }
  const spotify =
    host === 'open.spotify.com' &&
    /^\/(?:intl-[\w-]+\/)?(album|playlist)\/([A-Za-z0-9]{22})\b/.exec(pathname);
  if (spotify) return { kind: 'audio', list: () => spotifyTracks(spotify[1], spotify[2]) };
  const apple =
    host === 'music.apple.com' &&
    !searchParams.has('i') &&
    /^\/([a-z]{2})\/album\/(?:[^/]+\/)?(\d+)\/?$/.exec(pathname);
  if (apple) return { kind: 'audio', list: () => appleAlbumTracks(apple[1], apple[2]) };
  return null;
}

const fileName = text =>
  String(text ?? '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .slice(0, 100);

// Each entry is fetched like its own link; a failed one is recorded and skipped, the rest still go out.
export async function downloadCollection(link, { kind, list }, acquire) {
  const { max, noun } = KINDS[kind];
  const listed = await list(max);
  const entries = listed.entries.slice(0, max);
  if (!entries.length) throw new ValidationError("there's nothing to download in that list.");
  const limit = await maxDownloadBytes();
  let bytes = 0;
  let full = false;
  const failures = [];
  const results = await mapLimit(entries, ITEM_FANOUT, async (entry, index) => {
    if (bytes >= limit) {
      full = true;
      return null;
    }
    try {
      const { fileData } = await acquire(entry.url);
      if (!fileData?.path) return null;
      bytes += fileData.size;
      if (bytes > limit) {
        full = true;
        return null;
      }
      return { file: fileData, index };
    } catch (error) {
      jobSignal()?.throwIfAborted();
      logger.warn(
        `List item ${index + 1} failed (${entry.url}): ${describeCause(rootCause(error))}`
      );
      failures.push({ entry, error });
      return null;
    }
  });
  const got = results.filter(Boolean);
  if (!got.length) {
    throw failures[0]?.error ?? new ValidationError('nothing in that list could be downloaded.');
  }
  for (const { entry, error } of failures) {
    await recordFailure('download', {
      error: error.message,
      errorClass: error.name,
      url: entry.url,
      cause: error,
      options: { list: link },
    });
  }

  // Apple's track count can include songs its lookup leaves out; only the cap cuts a list.
  const cut = Math.max(listed.total ?? 0, listed.entries.length) > max;
  const parts = [
    cut &&
      (listed.total > max
        ? `the first ${entries.length} of ${listed.total} ${noun}`
        : `the first ${entries.length} ${noun}`),
    failures.length && `${failures.length} couldn't be downloaded`,
    full && `stopped at the ${formatFileSize(limit)} limit`,
  ].filter(Boolean);
  const note = parts.length ? `${parts.join(', ')}.` : undefined;

  if (got.length === 1) return { ...got[0].file, note };
  if (kind === 'video')
    return Object.assign(
      got.map(({ file }) => file),
      { note }
    );
  const numbered = got.map(({ file, index }) => ({
    ...file,
    filename: `${String(index + 1).padStart(2, '0')} ${file.filename}`,
  }));
  const zip = await writeZip(numbered, `${fileName(listed.title) || 'playlist'}.zip`);
  return { ...zip, audioReady: true, note };
}
