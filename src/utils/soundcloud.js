import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import { ValidationError } from './errors.js';
import { downloadWithYtdlp, getCookieArgs } from './ytdlp.js';

const logger = createLogger('soundcloud');
const execFileAsync = promisify(execFile);

export function isSoundCloudUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'soundcloud.com' || host.endsWith('.soundcloud.com');
  } catch {
    return false;
  }
}

// SoundCloud's metadata is public even when the audio is DRM-only.
export async function soundcloudTrack(url) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    ['-J', '--no-playlist', '--no-warnings', '--ignore-no-formats-error', ...getCookieArgs(), url],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }
  );
  const info = JSON.parse(stdout);
  const art =
    info.thumbnails?.find(t => t.id === 't500x500') ??
    info.thumbnails?.find(t => t.id === 'original') ??
    null;
  return {
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const VARIANT =
  /\b(remix|sped ?up|slowed|nightcore|cover|live|8d|reverb|instrumental|karaoke|bass ?boosted|edit)\b/i;
const MAX_DRIFT_S = 2;

// Only the artist's own upload (channel or "- Topic") counts; no match beats a wrong song.
export function pickMatch(track, entries) {
  const artist = norm(track.artist);
  const title = norm(String(track.title).replace(/\s*[([].*?[)\]]/g, ''));
  if (!artist || !title || !track.duration) return null;
  let best = null;
  for (const entry of entries) {
    const drift = Math.abs((entry.duration ?? -99) - track.duration);
    const channel = norm(entry.channel ?? entry.uploader);
    const official = channel === artist || channel === `${artist}topic`;
    if (drift > MAX_DRIFT_S || !official || !norm(entry.title).includes(title)) continue;
    if (VARIANT.test(entry.title) && !VARIANT.test(track.title)) continue;
    const score = (channel === `${artist}topic` ? 1 : 0) - drift;
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry ?? null;
}

async function youtubeCandidates(track) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--flat-playlist',
      '-J',
      '--no-warnings',
      '--js-runtimes',
      'bun',
      `ytsearch10:${track.artist} ${track.title}`,
    ],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(stdout).entries ?? [];
}

async function fetchCover(url) {
  if (!url) return null;
  try {
    if (!new URL(url).hostname.endsWith('.sndcdn.com')) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !/^image\/(jpeg|png)/.test(res.headers.get('content-type') ?? '')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length < 5 * 1024 * 1024 ? buffer : null;
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

// An mp3 carrying SoundCloud's title, artist and cover, whatever the audio came from.
export async function tagAudio(file, track) {
  const base = path.join(os.tmpdir(), `gronka-sc-${randomBytes(8).toString('hex')}`);
  const ext = path.extname(file.filename ?? '').toLowerCase() || '.m4a';
  const input = `${base}-in${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.bin'}`;
  const coverPath = `${base}-cover.jpg`;
  const output = `${base}-out.mp3`;
  const cover = await fetchCover(track.cover);
  try {
    await fs.writeFile(input, file.buffer, { flag: 'wx', mode: 0o600 });
    if (cover) await fs.writeFile(coverPath, cover, { flag: 'wx', mode: 0o600 });
    const meta = [
      ['title', track.title],
      ['artist', track.artist],
      ['genre', track.genre],
      ['date', track.year],
    ].flatMap(([key, value]) => (value ? ['-metadata', `${key}=${value}`] : []));
    await execFileAsync(
      'ffmpeg',
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
        ...(ext === '.mp3' ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-q:a', '2']),
        '-map_metadata',
        '-1',
        ...meta,
        ...(cover
          ? ['-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)']
          : []),
        '-id3v2_version',
        '3',
        output,
      ],
      { timeout: 120_000 }
    );
    const buffer = await fs.readFile(output);
    const name = `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 150);
    return {
      buffer,
      size: buffer.length,
      contentType: 'audio/mpeg',
      filename: `${name}.mp3`,
      audioReady: true,
    };
  } finally {
    await Promise.all(
      [input, coverPath, output].map(p => fs.rm(p, { force: true }).catch(() => {}))
    );
  }
}

export async function soundcloudViaYoutube(
  url,
  { adminUser = false, maxSize = Infinity, track = null } = {}
) {
  track ??= await soundcloudTrack(url);
  const match = pickMatch(track, await youtubeCandidates(track));
  if (!match) {
    throw new ValidationError(
      "soundcloud only streams this one encrypted (drm), and the artist's own upload isn't on youtube to use instead.",
      'DRM_PROTECTED'
    );
  }
  logger.info(`DRM SoundCloud track matched to YouTube ${match.id} (${match.channel})`);
  const audio = await downloadWithYtdlp(
    `https://www.youtube.com/watch?v=${match.id}`,
    adminUser,
    maxSize,
    'bestaudio[ext=m4a]/bestaudio',
    Infinity
  );
  const tagged = await tagAudio(audio, track);
  return {
    ...tagged,
    note: `soundcloud encrypts this one, so this is ${track.artist}'s own upload from youtube, tagged with soundcloud's cover and details.`,
  };
}
