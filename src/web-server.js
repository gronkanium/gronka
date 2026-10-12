import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './utils/logger.js';
import { initDatabase } from './utils/database.js';
import { r2Config } from './utils/config.js';
import { acquireMedia, extractAudio } from './core/acquire-media.js';
import { fetchContent, formatContent } from './content/index.js';
import { MAX_COMMENTS } from './content/schema.js';
import { getDisabledServiceLabel, getServiceForUrl } from './utils/download-services.js';
import { validateUrl, firstUrlIn, parseTimestamp, sanitizeFilename } from './utils/validation.js';
import { detectFileType } from './utils/storage.js';
import { uploadToR2, listObjectsInR2, deleteManyFromR2 } from './utils/r2-storage.js';
import { getStreamInfo, isYouTubeUrl } from './utils/ytdlp.js';
import { AppError, NetworkError, ValidationError } from './utils/errors.js';
import * as keys from './web/keys.js';
import { FFMPEG_INPUT_GUARD } from './utils/video-processor/utils.js';
import { trimItem } from './utils/video-processor/trim-item.js';
import { fromPath, tempPath, withJobDir, sweepJobDirs } from './utils/media-file.js';
import { getDirectMediaHeaders } from './utils/file-downloader.js';

const execFileAsync = promisify(execFile);

const logger = createLogger('web');

const env = (name, fallback) => process.env[name]?.trim() || fallback;
const WEB_ORIGIN = env('WEB_ORIGIN', 'https://web.gronka.dev');
const TURNSTILE_SECRET = env('TURNSTILE_SECRET', '');
const STREAM_BASE = env('WEB_STREAM_BASE', '');
const STREAM_KEY = env('WEB_STREAM_KEY', '');
const IP_LIMIT = Number(env('WEB_IP_LIMIT', 50));
const IP_WINDOW_MS = 10 * 60 * 1000;
const R2_LIMIT_BYTES = Number(env('WEB_R2_LIMIT_GB', 5)) * 1024 ** 3;
export const FILE_TTL_MS = 60 * 60 * 1000;
const R2_PREFIX = 'web/';
const MAX_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_WINDOWS = 10_000;
const DOCS_URL = 'https://web.gronka.dev/docs/';
const API_INDEX = {
  name: 'gronka',
  about:
    'paste a link, get the file. the same downloader as the gronka discord bot, as a json api.',
  version: 'v1',
  status: 'public preview',
  docs: DOCS_URL,
  openapi: 'https://web.gronka.dev/openapi.json',
  health: 'https://api.gronka.dev/v1/health',
  download: 'POST https://api.gronka.dev/v1/download',
  content: 'POST https://api.gronka.dev/v1/content',
  page: 'https://web.gronka.dev/',
};

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function signStreamToken(payload, key = STREAM_KEY) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

const FORWARDED_HEADERS = ['user-agent', 'referer', 'origin', 'accept', 'accept-language'];

function streamToken(part, filename) {
  const headers = Object.fromEntries(
    Object.entries(part.headers).filter(([name]) => FORWARDED_HEADERS.includes(name.toLowerCase()))
  );
  return signStreamToken({
    u: part.url,
    h: headers,
    n: filename,
    e: Math.floor((Date.now() + FILE_TTL_MS) / 1000),
  });
}

// A plain media link needs no resolving; the Worker also reaches hosts that block our IP (i.ibb.co).
export function directStreamInfo(url) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
  const ext = path.extname(name).slice(1).toLowerCase() || 'bin';
  return {
    title: name,
    ext,
    parts: [{ url, headers: getDirectMediaHeaders(url), ext, kind: 'file' }],
  };
}

// Lane 2: the Worker fetches from the source itself, so it only works for links not tied to
// our IP or cookies. The probe asks the Worker, from Cloudflare's side, whether that holds.
export async function workerLane(url, downloadMethod, { split = true, mute = false } = {}) {
  if (!STREAM_BASE || !STREAM_KEY || !['ytdlp', 'cobalt', 'direct'].includes(downloadMethod)) {
    return null;
  }
  // googlevideo links carry ip= for the address that resolved them (measured 2026-09-28).
  if (isYouTubeUrl(url)) {
    return null;
  }
  let info;
  try {
    info = downloadMethod === 'direct' ? directStreamInfo(url) : await getStreamInfo(url);
  } catch (error) {
    logger.debug(`No stream info, using R2: ${error.message}`);
    return null;
  }
  if (!info) {
    return null;
  }
  // Muting is free when the video comes as its own part: hand out only that one.
  if (mute) {
    const video = info.parts.filter(part => part.kind === 'video');
    if (info.parts.length < 2 || video.length !== 1) return null;
    info = { ...info, ext: video[0].ext, parts: video };
  }
  const merge = info.parts.length > 1;
  if (merge && !split) {
    return null;
  }
  const base = sanitizeFilename(info.title).replace(/\.[^.]+$/, '') || 'video';
  const parts = info.parts.map(part => {
    const filename = merge ? `${base}.${part.kind}.${part.ext}` : `${base}.${part.ext}`;
    return { ...part, filename, link: `${STREAM_BASE}/f/${streamToken(part, filename)}` };
  });
  const probes = await Promise.all(
    parts.map(part =>
      axios
        .get(part.link.replace('/f/', '/probe/'), { timeout: 10_000, validateStatus: () => true })
        .then(res => res.data)
        .catch(() => ({ ok: false }))
    )
  );
  if (!probes.every(probe => probe.ok)) {
    return null;
  }
  return {
    merge,
    filename: `${base}.${merge ? 'mp4' : info.ext}`,
    files: parts.map((part, i) => ({
      url: part.link,
      filename: part.filename,
      kind: part.kind,
      size: probes[i].size ?? null,
    })),
  };
}

// Lane 3 storage. The R2 listing is the only record: no database rows, nothing in memory
// that says what was fetched, and a restart loses nothing because the next sweep catches up.
let liveBytes = 0;
let reservedBytes = 0;
let sweeping = null;

export function sweepR2(now = Date.now()) {
  sweeping ??= (async () => {
    const objects = await listObjectsInR2(R2_PREFIX, r2Config);
    const expired = objects.filter(o => now - new Date(o.lastModified).getTime() > FILE_TTL_MS);
    const failed = expired.length
      ? await deleteManyFromR2(
          expired.map(o => o.key),
          r2Config
        )
      : [];
    if (failed.length) logger.warn(`Sweep could not delete ${failed.length} objects`);
    const gone = new Set(expired.map(o => o.key).filter(k => !failed.includes(k)));
    liveBytes = objects.reduce((sum, o) => sum + (gone.has(o.key) ? 0 : o.size), 0);
    return liveBytes;
  })().finally(() => (sweeping = null));
  return sweeping;
}

async function publishToR2(file, filename, contentType) {
  if (!file?.size) {
    throw new AppError('could not download this content.', 'DOWNLOAD_FAILED', 502);
  }
  if (liveBytes + reservedBytes + file.size > R2_LIMIT_BYTES) {
    throw new ValidationError('storage is full right now, try again in a few minutes.');
  }
  reservedBytes += file.size;
  try {
    return await uploadReserved(file, filename, contentType);
  } finally {
    reservedBytes -= file.size;
  }
}

async function uploadReserved(file, filename, contentType) {
  const name = sanitizeFilename(filename);
  const ext = path
    .extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');
  const type = contentType || 'application/octet-stream';
  const key = `${R2_PREFIX}${crypto.randomBytes(16).toString('hex')}${ext}`;
  const url = await uploadToR2(file, key, type, r2Config, {
    ContentDisposition: contentDisposition(name),
    CacheControl: 'public, max-age=3600',
  });
  liveBytes += file.size;
  return { url, filename: name, size: file.size, type: detectFileType(ext, type, file.head) };
}

// yt-dlp rewrites its cookie jar on exit, so it works on private copies of the read-only shared files.
export async function copyCookies(
  from = env('WEB_COOKIES_SRC', ''),
  to = env('WEB_COOKIES_DIR', '')
) {
  if (!from || !to) return;
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(from)) {
    const temp = path.join(to, `.${name}.tmp`);
    await fs.copyFile(path.join(from, name), temp);
    await fs.rename(temp, path.join(to, name));
  }
}

const isVideo = item =>
  /^video\//.test(item.contentType ?? '') || /\.(mp4|m4v|webm|mov|mkv)$/i.test(item.filename ?? '');

export async function stripAudio(item) {
  if (!isVideo(item)) return item;
  const ext = path.extname(item.filename ?? '').toLowerCase() || '.mp4';
  const output = await tempPath(ext);
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    ...FFMPEG_INPUT_GUARD,
    '-i',
    item.path,
    '-map',
    '0:v',
    '-c',
    'copy',
    output,
  ]);
  return fromPath(output, { filename: item.filename, contentType: item.contentType });
}

// Every file a download touches lives in one job dir, gone when the answer is sent; the signal
// cancels everything it started.
export const runDownload = (options, signal) =>
  withJobDir(() => downloadInJob(options), { signal });

async function downloadInJob({
  url,
  audio,
  mute = false,
  startTime = null,
  duration = null,
  split = true,
}) {
  const disabled = await getDisabledServiceLabel(url);
  if (disabled) {
    throw new ValidationError(`downloads from ${disabled} are turned off.`);
  }
  const acquired = await acquireMedia(url, {
    startTime,
    duration,
    urlOnly: !audio && !mute,
    streamFirst: audio ? null : (link, method) => workerLane(link, method, { split, mute }),
  });
  if (acquired.kind === 'urls') {
    return {
      lane: 'direct',
      files: acquired.urls.map(item => ({
        url: item.url,
        filename: item.filename,
        type: item.type,
      })),
    };
  }
  if (acquired.kind === 'stream') {
    return { lane: 'worker', ...acquired.streams };
  }
  const { fileData, downloadMethod } = acquired;
  const note = fileData?.note ? { note: fileData.note } : {};
  if (audio) {
    const { file, baseName } = await extractAudio(fileData, downloadMethod, {
      startTime,
      duration,
    });
    return {
      lane: 'r2',
      ...note,
      files: [await publishToR2(file, `${baseName}.mp3`, 'audio/mpeg')],
    };
  }
  const trim = (startTime !== null || duration !== null) && downloadMethod !== 'ytdlp';
  const items = Array.isArray(fileData) ? fileData : [fileData];
  const files = [];
  for (const item of items) {
    const cut =
      trim && !Array.isArray(fileData) ? await trimItem(item, { startTime, duration }) : item;
    const out = mute ? await stripAudio(cut) : cut;
    files.push(await publishToR2(out, out.filename, out.contentType));
  }
  return { lane: 'r2', ...note, files };
}

function parseSeconds(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = parseTimestamp(String(value));
  if (!parsed.valid) {
    throw new AppError(`${field}: ${parsed.error}`, 'BAD_REQUEST', 400);
  }
  return parsed.seconds;
}

export function parseDownloadRequest(body) {
  if (!body || typeof body !== 'object' || typeof body.url !== 'string') {
    throw new AppError('send a url.', 'BAD_REQUEST', 400);
  }
  const url = firstUrlIn(body.url.slice(0, 4096));
  const check = url ? validateUrl(url) : { valid: false, error: 'that is not a link.' };
  if (!check.valid) {
    throw new AppError(check.error, 'BAD_URL', 400);
  }
  const mode = body.mode ?? 'auto';
  if (!['auto', 'audio', 'mute'].includes(mode)) {
    throw new AppError('mode must be auto, audio or mute.', 'BAD_REQUEST', 400);
  }
  const start = parseSeconds(body.start, 'start');
  const end = parseSeconds(body.end, 'end');
  if (body.split !== undefined && typeof body.split !== 'boolean') {
    throw new AppError('split must be true or false.', 'BAD_REQUEST', 400);
  }
  if (end !== null && end <= (start ?? 0)) {
    throw new AppError('end must be after start.', 'BAD_REQUEST', 400);
  }
  return {
    url,
    audio: mode === 'audio',
    mute: mode === 'mute',
    split: body.split !== false,
    startTime: start,
    duration: end === null ? null : end - (start ?? 0),
  };
}

const CONTENT_FORMATS = ['json', 'text'];

function parseCount(value, field, max) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > max) {
    throw new AppError(`${field} must be a whole number from 0 to ${max}.`, 'BAD_REQUEST', 400);
  }
  return count;
}

export function parseContentRequest(body) {
  if (!body || typeof body !== 'object' || typeof body.url !== 'string') {
    throw new AppError('send a url.', 'BAD_REQUEST', 400);
  }
  const url = firstUrlIn(body.url.slice(0, 4096));
  const check = url ? validateUrl(url) : { valid: false, error: 'that is not a link.' };
  if (!check.valid) {
    throw new AppError(check.error, 'BAD_URL', 400);
  }
  const format = body.format ?? 'json';
  if (!CONTENT_FORMATS.includes(format)) {
    throw new AppError('format must be json or text.', 'BAD_REQUEST', 400);
  }
  if (body.thread !== undefined && typeof body.thread !== 'boolean') {
    throw new AppError('thread must be true or false.', 'BAD_REQUEST', 400);
  }
  const transcript = body.transcript ?? false;
  if (
    typeof transcript !== 'boolean' &&
    !(typeof transcript === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(transcript))
  ) {
    throw new AppError('transcript must be true, false or a language code.', 'BAD_REQUEST', 400);
  }
  return {
    url,
    format,
    transcript,
    thread: body.thread !== false,
    depth: parseCount(body.depth, 'depth', 10),
    comments: parseCount(body.comments, 'comments', MAX_COMMENTS),
  };
}

export async function verifyTurnstile(token, action, secret = TURNSTILE_SECRET) {
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) {
    return false;
  }
  try {
    const { data: out } = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({ secret, response: token }),
      { timeout: 10_000, validateStatus: () => true }
    );
    return (
      out.success === true && out.hostname === new URL(WEB_ORIGIN).hostname && out.action === action
    );
  } catch {
    return false;
  }
}

// A source that failed or refused is the upstream's fault (502), not a server error; gone is 404.
const STATUS_BY_CODE = { CONTENT_GONE: 404 };

function toApiError(error, url, fallback = DOWNLOAD_FALLBACK) {
  if (error instanceof AppError && error.message) {
    const status =
      STATUS_BY_CODE[error.code] ??
      (error instanceof NetworkError && error.statusCode === 500 ? 502 : error.statusCode);
    return { status, error: { code: error.code, message: error.message } };
  }
  logger.error(`${fallback.what} failed (${getServiceForUrl(url)?.id ?? 'other'}):`, error);
  return { status: 502, error: { code: fallback.code, message: fallback.message } };
}
const DOWNLOAD_FALLBACK = {
  what: 'Download',
  code: 'DOWNLOAD_FAILED',
  message: 'could not download this content.',
};
const CONTENT_FALLBACK = {
  what: 'Content fetch',
  code: 'CONTENT_FAILED',
  message: 'could not read this content.',
};

// Cloudflare drops a tunnelled request that sends nothing for ~100 s, so a download that finishes
// sooner answers with its real status; a longer one keeps the line open with whitespace, which is
// valid before a JSON document, and reports a late failure in the body.
const ANSWER_WITHIN_MS = 80_000;

function heartbeatJson(work, headers, onCancel) {
  const encoder = new TextEncoder();
  let timer;
  const body = new ReadableStream({
    start(controller) {
      const send = text => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          clearInterval(timer);
        }
      };
      send(' ');
      timer = setInterval(() => send(' '), HEARTBEAT_MS);
      work.then(result => {
        clearInterval(timer);
        send(JSON.stringify(result));
        try {
          controller.close();
        } catch {
          // client already went away
        }
      });
    },
    cancel() {
      clearInterval(timer);
      onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function apiError(error, headers) {
  const { code, message, retryAfter } = error;
  if (!retryAfter) {
    return json({ error: { code, message } }, error.statusCode, headers);
  }
  return json({ error: { code, message, retryAfter } }, error.statusCode, {
    ...headers,
    'Retry-After': String(retryAfter),
  });
}

function retryLater(message, code, status, seconds) {
  return Object.assign(new AppError(message, code, status), { retryAfter: Math.max(1, seconds) });
}

async function readJson(req) {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    throw new AppError('request too large.', 'BAD_REQUEST', 413);
  }
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('send json.', 'BAD_REQUEST', 400);
  }
}

export function createHandler({
  verify = verifyTurnstile,
  download = runDownload,
  content = fetchContent,
  ipLimit = IP_LIMIT,
  signupLimit = 3,
  authLimit = 30,
  answerWithinMs = ANSWER_WITHIN_MS,
} = {}) {
  // Per-IP state is keyed by an HMAC under a key that rotates daily and lives only here.
  let dayKey = null;
  let day = null;
  const windows = new Map();
  const stats = { started: new Date().toISOString(), lanes: {}, content: {}, errors: {} };

  const ipKey = (req, server) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dayKey = crypto.randomBytes(32);
      windows.clear();
    }
    // Only cloudflared can reach this server, so its header is the real client address.
    const ip = req.headers.get('cf-connecting-ip') || server?.requestIP?.(req)?.address || '';
    return crypto.createHmac('sha256', dayKey).update(ip).digest('base64url');
  };

  const overLimit = (key, limit) => {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || entry.resetAt <= now) {
      // Every window is re-inserted when it starts, so the Map is ordered by expiry: prune from the front.
      for (const [old, value] of windows) {
        if (value.resetAt > now && windows.size < MAX_WINDOWS) break;
        windows.delete(old);
      }
      windows.delete(key);
      windows.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
      return 0;
    }
    entry.count += 1;
    return entry.count > limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  };

  const limit = (key, max, message = 'too many requests, try again in a few minutes.') => {
    const wait = overLimit(key, max);
    if (wait) {
      throw retryLater(message, 'RATE_LIMITED', 429, wait);
    }
  };

  // Rate limit first, so a flood never reaches Turnstile's siteverify.
  async function requireHuman(req, server, body, action, max) {
    limit(`${action}:${ipKey(req, server)}`, max);
    if (!(await verify(body.turnstile, action))) {
      throw new AppError('verification failed, reload the page.', 'VERIFICATION_FAILED', 403);
    }
  }

  const corsHeaders = req => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.headers.get('origin') === WEB_ORIGIN) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': WEB_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    return headers;
  };

  async function requireKey(auth) {
    const id = await keys.verifyApiKey(String(auth ?? '').replace(/^Bearer\s+/i, ''));
    if (!id) {
      throw new AppError('that api key is not valid.', 'UNAUTHORIZED', 401);
    }
    return id;
  }

  // An api key names the account, otherwise the ip is the caller and Turnstile proves a person.
  // Downloads and content reads share one quota per caller.
  async function requireCaller(req, server, body, action, message) {
    let caller;
    const auth = req.headers.get('authorization');
    if (auth) {
      // Guessing keys is limited per address before any lookup.
      limit(`auth:${ipKey(req, server)}`, authLimit);
      caller = `key:${await requireKey(auth)}`;
    } else {
      caller = `ip:${ipKey(req, server)}`;
    }
    limit(caller, ipLimit, message);
    if (!auth && !(await verify(body.turnstile, action))) {
      throw new AppError('verification failed, reload the page.', 'VERIFICATION_FAILED', 403);
    }
  }

  async function handleContent(req, server, headers) {
    const body = await readJson(req);
    const request = parseContentRequest(body);
    await requireCaller(
      req,
      server,
      body,
      'content',
      'too many requests, try again in a few minutes.'
    );
    let result;
    try {
      result = await content(request.url, request);
    } catch (error) {
      // No padding here: a read is quick, so the http status carries the outcome.
      const { status, error: apiErr } = toApiError(error, request.url, CONTENT_FALLBACK);
      stats.errors[apiErr.code] = (stats.errors[apiErr.code] ?? 0) + 1;
      throw new AppError(apiErr.message, apiErr.code, status);
    }
    stats.content[result.source] = (stats.content[result.source] ?? 0) + 1;
    if (request.format === 'text') {
      return new Response(formatContent(result, 'text'), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return json(result, 200, headers);
  }

  async function handleDownload(req, server, headers) {
    const body = await readJson(req);
    const job = parseDownloadRequest(body);
    await requireCaller(
      req,
      server,
      body,
      'download',
      'too many downloads, try again in a few minutes.'
    );
    // A closed tab or dropped connection cancels the download, wherever it has got to.
    const cancel = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, cancel.signal]) : cancel.signal;
    const work = download(job, signal)
      .then(result => {
        stats.lanes[result.lane] = (stats.lanes[result.lane] ?? 0) + 1;
        return { status: 200, body: result };
      })
      .catch(error => {
        if (signal.aborted) {
          stats.cancelled = (stats.cancelled ?? 0) + 1;
          return { status: 499, body: { error: { code: 'CANCELLED', message: 'cancelled.' } } };
        }
        const { status, error: apiErr } = toApiError(error, job.url);
        stats.errors[apiErr.code] = (stats.errors[apiErr.code] ?? 0) + 1;
        return { status, body: { error: apiErr } };
      });
    let timer;
    const early = await Promise.race([
      work,
      new Promise(resolve => (timer = setTimeout(resolve, answerWithinMs, null))),
    ]).finally(() => clearTimeout(timer));
    if (early) return json(early.body, early.status, headers);
    return heartbeatJson(
      work.then(answer => answer.body),
      headers,
      () => cancel.abort()
    );
  }

  async function route(req, server, headers) {
    const { pathname } = new URL(req.url);
    const { method } = req;

    if (method === 'GET' && ['/', '/v1', '/v1/'].includes(pathname)) {
      return new Response(JSON.stringify(API_INDEX, null, 2), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
    if (method === 'GET' && (pathname === '/v1/health' || pathname === '/health')) {
      return json({ ok: true }, 200, headers);
    }
    if (method === 'POST' && pathname === '/v1/download') {
      return handleDownload(req, server, headers);
    }
    if (method === 'POST' && pathname === '/v1/content') {
      return handleContent(req, server, headers);
    }
    if (method === 'POST' && pathname === '/v1/keys') {
      await requireHuman(req, server, await readJson(req), 'key', signupLimit);
      return json(await keys.createApiKey(), 201, headers);
    }
    if (method === 'DELETE' && pathname === '/v1/keys') {
      limit(`auth:${ipKey(req, server)}`, authLimit);
      await keys.revokeApiKey(await requireKey(req.headers.get('authorization')));
      return json({ ok: true }, 200, headers);
    }
    throw new AppError(`no such route. the api is described at ${DOCS_URL}`, 'NOT_FOUND', 404);
  }

  async function fetchHandler(req, server) {
    const headers = corsHeaders(req);
    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }
      return await route(req, server, headers);
    } catch (error) {
      if (error instanceof AppError) {
        return apiError(error, headers);
      }
      logger.error('Request failed:', error);
      return json({ error: { code: 'INTERNAL', message: 'something broke.' } }, 500, headers);
    }
  }

  fetchHandler.stats = () => ({ ...stats, r2LiveBytes: liveBytes });
  return fetchHandler;
}

if (import.meta.main) {
  if (!TURNSTILE_SECRET) {
    throw new Error('TURNSTILE_SECRET is required');
  }
  await copyCookies();
  setInterval(
    () => copyCookies().catch(error => logger.warn(`Cookie copy failed: ${error.message}`)),
    10 * 60 * 1000
  );
  await initDatabase();
  await keys.ensureWebSchema();
  const handler = createHandler();
  Bun.serve({
    port: Number(env('WEB_PORT', 3000)),
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: 60,
    fetch: handler,
  });
  // Owner-only counters, reachable from inside the container: docker exec ... curl.
  Bun.serve({
    hostname: '127.0.0.1',
    port: Number(env('WEB_STATS_PORT', 3099)),
    fetch: () => Response.json(handler.stats()),
  });
  const sweep = () =>
    Promise.all([
      sweepR2().catch(error => logger.warn(`R2 sweep failed: ${error.message}`)),
      sweepJobDirs().catch(error => logger.warn(`Job dir sweep failed: ${error.message}`)),
    ]);
  await sweep();
  setInterval(sweep, 5 * 60 * 1000);
  logger.info('gronka-web listening');
}
