import crypto from 'node:crypto';
import path from 'node:path';
import { createLogger } from './utils/logger.js';
import { initDatabase } from './utils/database.js';
import { r2Config } from './utils/config.js';
import { acquireMedia, extractAudio } from './core/acquire-media.js';
import { getDisabledServiceLabel, getServiceForUrl } from './utils/download-services.js';
import { validateUrl, firstUrlIn, parseTimestamp, sanitizeFilename } from './utils/validation.js';
import { detectFileType } from './utils/storage.js';
import { uploadToR2, listObjectsInR2, deleteFromR2 } from './utils/r2-storage.js';
import { getStreamInfo, isYouTubeUrl } from './utils/ytdlp.js';
import { AppError, ValidationError } from './utils/errors.js';
import * as accounts from './web/accounts.js';

const logger = createLogger('web');

const env = (name, fallback) => process.env[name]?.trim() || fallback;
const WEB_ORIGIN = env('WEB_ORIGIN', 'https://web.gronka.dev');
const TURNSTILE_SECRET = env('TURNSTILE_SECRET', '');
const STREAM_BASE = env('WEB_STREAM_BASE', '');
const STREAM_KEY = env('WEB_STREAM_KEY', '');
const MAX_JOBS = Number(env('WEB_MAX_JOBS', 3));
const IP_LIMIT = Number(env('WEB_IP_LIMIT', 10));
const IP_WINDOW_MS = 10 * 60 * 1000;
const R2_LIMIT_BYTES = Number(env('WEB_R2_LIMIT_GB', 5)) * 1024 ** 3;
export const FILE_TTL_MS = 60 * 60 * 1000;
const R2_PREFIX = 'web/';
const MAX_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 15_000;

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

// Lane 2: the Worker fetches from the source itself, so it only works for links not tied to
// our IP or cookies. The probe asks the Worker, from Cloudflare's side, whether that holds.
async function workerLane(url, downloadMethod) {
  if (!STREAM_BASE || !STREAM_KEY || !['ytdlp', 'cobalt'].includes(downloadMethod)) {
    return null;
  }
  // googlevideo links carry ip= for the address that resolved them (measured 2026-09-28).
  if (isYouTubeUrl(url)) {
    return null;
  }
  let info;
  try {
    info = await getStreamInfo(url);
  } catch (error) {
    logger.debug(`No stream info, using R2: ${error.message}`);
    return null;
  }
  if (!info) {
    return null;
  }
  const merge = info.parts.length > 1;
  const base = sanitizeFilename(info.title).replace(/\.[^.]+$/, '') || 'video';
  const parts = info.parts.map(part => {
    const filename = merge ? `${base}.${part.kind}.${part.ext}` : `${base}.${part.ext}`;
    return { ...part, filename, link: `${STREAM_BASE}/f/${streamToken(part, filename)}` };
  });
  const probes = await Promise.all(
    parts.map(part =>
      fetch(part.link.replace('/f/', '/probe/'), { signal: AbortSignal.timeout(10_000) })
        .then(res => res.json())
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

export async function sweepR2(now = Date.now()) {
  const objects = await listObjectsInR2(R2_PREFIX, r2Config);
  let kept = 0;
  for (const object of objects) {
    if (now - new Date(object.lastModified).getTime() > FILE_TTL_MS) {
      await deleteFromR2(object.key, r2Config).catch(error =>
        logger.warn(`Sweep could not delete an object: ${error.message}`)
      );
    } else {
      kept += object.size;
    }
  }
  liveBytes = kept;
  return kept;
}

async function publishToR2(buffer, filename, contentType) {
  if (liveBytes + buffer.length > R2_LIMIT_BYTES) {
    throw new ValidationError('storage is full right now, try again in a few minutes.');
  }
  const name = sanitizeFilename(filename);
  const ext = path
    .extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');
  const type = contentType || 'application/octet-stream';
  const key = `${R2_PREFIX}${crypto.randomBytes(16).toString('hex')}${ext}`;
  const url = await uploadToR2(
    buffer,
    key,
    type,
    r2Config,
    {},
    {
      ContentDisposition: contentDisposition(name),
      CacheControl: 'public, max-age=3600',
    }
  );
  liveBytes += buffer.length;
  return { url, filename: name, size: buffer.length, type: detectFileType(ext, type, buffer) };
}

export async function runDownload({ url, audio, startTime, duration }) {
  const disabled = await getDisabledServiceLabel(url);
  if (disabled) {
    throw new ValidationError(`downloads from ${disabled} are turned off.`);
  }
  const acquired = await acquireMedia(url, {
    startTime,
    duration,
    urlOnly: !audio,
    streamFirst: audio ? null : workerLane,
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
  if (audio) {
    const { buffer, baseName } = await extractAudio(fileData, downloadMethod, {
      startTime,
      duration,
    });
    return { lane: 'r2', files: [await publishToR2(buffer, `${baseName}.mp3`, 'audio/mpeg')] };
  }
  const items = Array.isArray(fileData) ? fileData : [fileData];
  const files = [];
  for (const item of items) {
    files.push(await publishToR2(item.buffer, item.filename, item.contentType));
  }
  return { lane: 'r2', files };
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
  if (mode !== 'auto' && mode !== 'audio') {
    throw new AppError('mode must be auto or audio.', 'BAD_REQUEST', 400);
  }
  const start = parseSeconds(body.start, 'start');
  const end = parseSeconds(body.end, 'end');
  if (end !== null && end <= (start ?? 0)) {
    throw new AppError('end must be after start.', 'BAD_REQUEST', 400);
  }
  return {
    url,
    audio: mode === 'audio',
    startTime: start,
    duration: end === null ? null : end - (start ?? 0),
  };
}

export async function verifyTurnstile(token, action, secret = TURNSTILE_SECRET) {
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) {
    return false;
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(10_000),
    });
    const out = await res.json();
    return (
      out.success === true && out.hostname === new URL(WEB_ORIGIN).hostname && out.action === action
    );
  } catch {
    return false;
  }
}

function toApiError(error, url) {
  if (error instanceof AppError && error.message) {
    return { code: error.code, message: error.message };
  }
  logger.error(`Download failed (${getServiceForUrl(url)?.id ?? 'other'}):`, error);
  return { code: 'DOWNLOAD_FAILED', message: 'could not download this content.' };
}

// Cloudflare drops a tunnelled request that sends nothing for ~100 s, and a big download
// takes longer. Whitespace before a JSON document is valid JSON, so send some while working.
function heartbeatJson(work, headers) {
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

const apiError = (error, headers) =>
  json({ error: { code: error.code, message: error.message } }, error.statusCode, headers);

const SESSION_COOKIE = 'gw_session';

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
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
  maxJobs = MAX_JOBS,
  ipLimit = IP_LIMIT,
  signupLimit = 3,
  loginLimit = 10,
} = {}) {
  // Per-IP state is keyed by an HMAC under a key that rotates daily and lives only here.
  let dayKey = null;
  let day = null;
  const windows = new Map();
  const activeCallers = new Set();
  let activeJobs = 0;
  const stats = { started: new Date().toISOString(), lanes: {}, errors: {} };

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
      windows.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  };

  const limit = (key, max) => {
    if (overLimit(key, max)) {
      throw new AppError('too many requests, try again in a few minutes.', 'RATE_LIMITED', 429);
    }
  };

  const corsHeaders = req => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.headers.get('origin') === WEB_ORIGIN) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': WEB_ORIGIN,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    return headers;
  };

  // Cookie-authenticated routes: the Origin check is the CSRF guard, SameSite=Strict the second one.
  async function requireSession(req) {
    if (req.method !== 'GET' && req.headers.get('origin') !== WEB_ORIGIN) {
      throw new AppError('not allowed from here.', 'FORBIDDEN', 403);
    }
    const accountId = await accounts.getSessionAccount(readCookie(req, SESSION_COOKIE));
    if (!accountId) {
      throw new AppError('log in first.', 'UNAUTHORIZED', 401);
    }
    return accountId;
  }

  async function handleDownload(req, server, headers) {
    const body = await readJson(req);
    const job = parseDownloadRequest(body);

    let caller;
    const auth = req.headers.get('authorization');
    if (auth) {
      const key = await accounts.verifyApiKey(auth.replace(/^Bearer\s+/i, ''));
      if (!key) {
        throw new AppError('that api key is not valid.', 'UNAUTHORIZED', 401);
      }
      caller = `key:${key.keyId}`;
    } else {
      caller = `ip:${ipKey(req, server)}`;
    }
    if (activeCallers.has(caller)) {
      throw new AppError('one download at a time.', 'RATE_LIMITED', 429);
    }
    if (overLimit(caller, ipLimit)) {
      throw new AppError('too many downloads, try again in a few minutes.', 'RATE_LIMITED', 429);
    }
    if (!auth && !(await verify(body.turnstile, 'download'))) {
      throw new AppError('verification failed, reload the page.', 'VERIFICATION_FAILED', 403);
    }
    if (activeJobs >= maxJobs) {
      throw new AppError('busy right now, try again in a moment.', 'BUSY', 503);
    }

    activeJobs += 1;
    activeCallers.add(caller);
    const work = download(job)
      .then(result => {
        stats.lanes[result.lane] = (stats.lanes[result.lane] ?? 0) + 1;
        return result;
      })
      .catch(error => {
        const apiErr = toApiError(error, job.url);
        stats.errors[apiErr.code] = (stats.errors[apiErr.code] ?? 0) + 1;
        return { error: apiErr };
      })
      .finally(() => {
        activeJobs -= 1;
        activeCallers.delete(caller);
      });
    return heartbeatJson(work, headers);
  }

  async function route(req, server, headers) {
    const { pathname } = new URL(req.url);
    const { method } = req;
    const withCookie = (data, status, token, maxAge) =>
      json(data, status, { ...headers, 'Set-Cookie': sessionCookie(token, maxAge) });

    if (method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
      return json({ ok: true }, 200, headers);
    }
    if (method === 'POST' && pathname === '/api/download') {
      return handleDownload(req, server, headers);
    }
    if (method === 'POST' && pathname === '/api/account') {
      const body = await readJson(req);
      limit(`signup:${ipKey(req, server)}`, signupLimit);
      if (!(await verify(body.turnstile, 'account'))) {
        throw new AppError('verification failed, reload the page.', 'VERIFICATION_FAILED', 403);
      }
      const { id, number } = await accounts.createAccount();
      const token = await accounts.createSession(id);
      return withCookie({ id, number }, 201, token, accounts.SESSION_MS / 1000);
    }
    if (method === 'POST' && pathname === '/api/session') {
      const body = await readJson(req);
      limit(`login:${ipKey(req, server)}`, loginLimit);
      if (!(await verify(body.turnstile, 'login'))) {
        throw new AppError('verification failed, reload the page.', 'VERIFICATION_FAILED', 403);
      }
      const accountId = await accounts.verifyAccountNumber(body.number);
      if (!accountId) {
        throw new AppError('that account number is not right.', 'UNAUTHORIZED', 401);
      }
      const token = await accounts.createSession(accountId);
      return withCookie({ id: accountId }, 200, token, accounts.SESSION_MS / 1000);
    }
    if (method === 'DELETE' && pathname === '/api/session') {
      await accounts.deleteSession(readCookie(req, SESSION_COOKIE));
      return withCookie({ ok: true }, 200, '', 0);
    }
    if (pathname === '/api/account' && (method === 'GET' || method === 'DELETE')) {
      const accountId = await requireSession(req);
      if (method === 'GET') {
        return json(await accounts.getAccountSummary(accountId), 200, headers);
      }
      await accounts.deleteAccount(accountId);
      return withCookie({ ok: true }, 200, '', 0);
    }
    if (method === 'POST' && pathname === '/api/account/rotate') {
      const accountId = await requireSession(req);
      return json({ number: await accounts.rotateAccountNumber(accountId) }, 200, headers);
    }
    if (method === 'POST' && pathname === '/api/keys') {
      const accountId = await requireSession(req);
      const body = await readJson(req);
      const created = await accounts.createApiKey(accountId, body.label);
      if (!created) {
        throw new AppError('10 keys is the limit, revoke one first.', 'KEY_LIMIT', 400);
      }
      return json(created, 201, headers);
    }
    const keyMatch = pathname.match(/^\/api\/keys\/(gk_[0-9a-z]{8})$/);
    if (method === 'DELETE' && keyMatch) {
      const accountId = await requireSession(req);
      if (!(await accounts.revokeApiKey(accountId, keyMatch[1]))) {
        throw new AppError('no such key.', 'NOT_FOUND', 404);
      }
      return json({ ok: true }, 200, headers);
    }
    throw new AppError('not found.', 'NOT_FOUND', 404);
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

  fetchHandler.stats = () => ({ ...stats, activeJobs, r2LiveBytes: liveBytes });
  return fetchHandler;
}

if (import.meta.main) {
  if (!TURNSTILE_SECRET) {
    throw new Error('TURNSTILE_SECRET is required');
  }
  await initDatabase();
  await accounts.ensureWebSchema();
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
  const sweep = () => sweepR2().catch(error => logger.warn(`R2 sweep failed: ${error.message}`));
  await sweep();
  setInterval(sweep, 5 * 60 * 1000);
  logger.info('gronka-web listening');
}
