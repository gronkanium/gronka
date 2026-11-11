import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { createLogger } from './logger.js';
import { ValidationError, describeCause, withCause } from './errors.js';
import { fetchPage, ssrfGuardedRequest } from './ssrf-guard.js';
import { fromPath, tempPath, jobSignal } from './media-file.js';
import { runFfmpeg } from './video-processor/utils.js';
import { downloadWithYtdlp, getCookieArgs, ONE_ITEM } from './ytdlp.js';
import { hostUnder } from './url-host.js';

const logger = createLogger('soundcloud');
const execFileAsync = promisify(execFile);

export function isSoundCloudUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hostUnder(host, 'soundcloud.com');
  } catch {
    return false;
  }
}

// SoundCloud's metadata is public even when the audio is DRM-only.
export async function soundcloudTrack(url) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--ignore-config',
      '-J',
      ...ONE_ITEM,
      '--no-warnings',
      '--ignore-no-formats-error',
      '--ies',
      'default,-generic',
      ...getCookieArgs(),
      '--',
      url,
    ],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024, signal: jobSignal() }
  );
  const parsed = JSON.parse(stdout);
  const info = parsed.entries?.[0] ?? parsed;
  const art =
    info.thumbnails?.find(t => t.id === 't500x500') ??
    info.thumbnails?.find(t => t.id === 'original') ??
    null;
  return {
    site: 'soundcloud',
    title: info.title,
    artist: info.artist || info.uploader,
    duration: info.duration,
    genre: info.genre || null,
    year: info.upload_date ? info.upload_date.slice(0, 4) : null,
    cover: art?.url ?? info.thumbnail ?? null,
    // DRM-only tracks list no formats at all, logged in or not.
    drm: (info.formats ?? []).length === 0,
  };
}

const norm = text =>
  String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const VARIANT =
  /\b(remix|sped ?up|slowed|nightcore|cover|live|8d|reverb|instrumental|karaoke|bass ?boosted|edit|re-?record(ed|ing)?)\b/i;
const MAX_DRIFT_S = 2;
// Spotify writes a version as "Dreams - 2004 Remaster", JioSaavn and Apple as "Dreams (2004 Remaster)".
const plain = text =>
  String(text ?? '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/ - [^-]*remaster[^-]*$/i, '');
const untagged = text => norm(plain(text));
const FEATURING = /\s(?:feat\.?|featuring|ft\.?)\s/i;
// "A featuring B" bills two artists for sure; "A, B & C" may be one name ("Tyler, The Creator").
const billedOf = credit =>
  [credit, ...String(credit ?? '').split(FEATURING)].map(norm).filter(Boolean);
const artistsOf = credit =>
  [credit, ...String(credit ?? '').split(/,|\s(?:feat\.?|featuring|ft\.?|&|x)\s/i)]
    .map(norm)
    .filter(Boolean);
// Classical listings read "Einaudi: Nuvole Bianche"; the prefix has to be part of an artist's name.
const workOf = (text, names) => {
  const [, who, rest] = /^([^:]{1,40}):\s+(.+)$/.exec(String(text ?? '')) ?? [];
  return who && norm(who) && names.some(name => name.includes(norm(who)))
    ? untagged(rest)
    : untagged(text);
};

// Only an official upload counts; no match beats a wrong song.
export function pickMatch(track, entries) {
  const names = artistsOf(track.artist);
  const title = untagged(track.title);
  if (!names.length || !title || !track.duration) return null;
  const billed = billedOf(track.artist);
  let best = null;
  for (const entry of entries) {
    const drift = Math.abs((entry.duration ?? -99) - track.duration);
    const channel = norm(entry.channel ?? entry.uploader);
    const own = names.some(
      name =>
        channel === `${name}topic` ||
        (channel === name && (billed.includes(name) || entry.channel_is_verified))
    );
    // YouTube's art tracks, often under the artist's name in another script.
    const artTrack = / - Topic$/.test(entry.channel ?? '') && untagged(entry.title) === title;
    const label =
      entry.channel_is_verified && names.some(name => untagged(entry.title) === `${name}${title}`);
    if (drift > MAX_DRIFT_S || !(own || artTrack || label)) continue;
    if (!norm(entry.title).includes(title)) continue;
    if (VARIANT.test(entry.title) && !VARIANT.test(track.title)) continue;
    const score = (own ? 2 : 0) + (artTrack ? 1 : 0) - drift;
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry ?? null;
}

// JioSaavn serves the label's own file as plain 320k AAC; only the 320k original counts.
export function pickSaavn(track, songs) {
  const names = artistsOf(track.artist);
  const title = untagged(track.title);
  if (!names.length || !title || !track.duration) return null;
  return (
    songs.find(song => {
      const info = song.more_info ?? {};
      return (
        info['320kbps'] === 'true' &&
        workOf(song.title, names) === title &&
        !(VARIANT.test(song.title) && !VARIANT.test(track.title)) &&
        (info.artistMap?.primary_artists ?? []).some(a => names.includes(norm(a.name))) &&
        Math.abs(Number(info.duration) - track.duration) <= MAX_DRIFT_S
      );
    })?.perma_url ?? null
  );
}

// Search hides most of the catalogue outside India and reads the country from X-Forwarded-For; n=40 is its page cap.
async function saavnCandidates(query) {
  const { data } = await fetchPage(
    `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=40&p=1&q=${encodeURIComponent(query)}`,
    {
      failMessage: 'jiosaavn search failed',
      responseType: 'json',
      headers: { 'X-Forwarded-For': '164.100.1.1' },
    }
  );
  return data?.results ?? [];
}

async function youtubeCandidates(query) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--ignore-config',
      '--flat-playlist',
      '-J',
      '--no-warnings',
      '--js-runtimes',
      'bun',
      `ytsearch10:${query}`,
    ],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024, signal: jobSignal() }
  );
  return JSON.parse(stdout).entries ?? [];
}

async function fetchCover(url) {
  if (!url) return null;
  try {
    if (!hostUnder(new URL(url).hostname, ['sndcdn.com', 'scdn.co', 'mzstatic.com'])) return null;
    const res = await axios.get(url, {
      ...ssrfGuardedRequest(),
      responseType: 'arraybuffer',
      timeout: 10_000,
      maxContentLength: 5 * 1024 * 1024,
      validateStatus: () => true,
    });
    if (
      res.status < 200 ||
      res.status >= 300 ||
      !/^image\/(jpeg|png)/.test(res.headers['content-type'] ?? '')
    )
      return null;
    return Buffer.from(res.data);
  } catch (error) {
    logger.warn(`No cover: ${error.message}`);
    return null;
  }
}

// Audio-only allowlist: the video guard leaves out mp3 and ogg, and nothing here is a playlist.
const AUDIO_INPUT_GUARD = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,mp3,ogg,flac,wav,aac,image2,jpeg_pipe,png_pipe',
];

// Copies the audio untouched next to the track page's tags and cover; only a codec .m4a can't hold is encoded.
export async function tagAudio(file, track) {
  const ext = path.extname(file.filename ?? '').toLowerCase() || '.m4a';
  const copy = ext === '.mp3' ? '.mp3' : ['.m4a', '.mp4', '.aac'].includes(ext) ? '.m4a' : null;
  const out = copy ?? '.mp3';
  const input = file.path;
  const coverPath = await tempPath('.jpg');
  const output = await tempPath(out);
  const cover = await fetchCover(track.cover);
  if (cover) await fs.writeFile(coverPath, cover, { flag: 'wx', mode: 0o600 });
  const meta = [
    ['title', track.title],
    ['artist', track.artist],
    ['genre', track.genre],
    ['date', track.year],
  ].flatMap(([key, value]) => (value ? ['-metadata', `${key}=${value}`] : []));
  await runFfmpeg(
    [
      '-v',
      'error',
      ...AUDIO_INPUT_GUARD,
      '-i',
      input,
      ...(cover ? [...AUDIO_INPUT_GUARD, '-i', coverPath] : []),
      '-map',
      '0:a:0',
      ...(cover ? ['-map', '1:0', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
      ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-q:a', '2']),
      '-map_metadata',
      '-1',
      ...meta,
      ...(cover
        ? ['-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)']
        : []),
      ...(out === '.mp3' ? ['-id3v2_version', '3'] : []),
      output,
    ],
    { signal: AbortSignal.timeout(120_000) }
  );
  const name = `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 150);
  return fromPath(output, {
    contentType: out === '.mp3' ? 'audio/mpeg' : 'audio/mp4',
    filename: `${name}${out}`,
    audioReady: true,
  });
}

const DRM = {
  soundcloud: { only: 'soundcloud only streams this one' },
  spotify: { only: 'spotify only streams its audio' },
  'apple music': { only: 'apple music only streams its audio' },
};

async function fromSaavn(track) {
  try {
    const url = pickSaavn(track, await saavnCandidates(`${track.artist} ${track.title}`));
    if (!url || !hostUnder(new URL(url).hostname, 'jiosaavn.com')) return { why: 'no 320k match' };
    logger.debug(`DRM ${track.site} track matched to JioSaavn ${url}`);
    return { file: await downloadWithYtdlp(url, { quality: '320' }) };
  } catch (error) {
    logger.warn(`JioSaavn unavailable, trying YouTube: ${describeCause(error)}`);
    return { why: describeCause(error) };
  }
}

export async function downloadMatchedTrack(track) {
  const drm = DRM[track.site];
  const saavn = await fromSaavn(track);
  if (saavn.file) return tagAudio(saavn.file, track);
  const match =
    pickMatch(track, await youtubeCandidates(`${track.artist} ${plain(track.title)}`)) ??
    pickMatch(track, await youtubeCandidates(`${track.artist} - Topic ${plain(track.title)}`));
  if (!match) {
    throw withCause(
      new ValidationError(
        `${drm.only} encrypted (drm), and the artist's own upload isn't on youtube to use instead.`,
        'DRM_PROTECTED'
      ),
      `jiosaavn: ${saavn.why}; youtube: no official upload`
    );
  }
  logger.debug(`DRM ${track.site} track matched to YouTube ${match.id} (${match.channel})`);
  const audio = await downloadWithYtdlp(`https://www.youtube.com/watch?v=${match.id}`, {
    quality: 'bestaudio[ext=m4a]/bestaudio',
  });
  return tagAudio(audio, track);
}
