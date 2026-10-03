import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { createLogger, withLogRef } from './logger.js';

const logger = createLogger('media-file');

// Real disk, never tmpfs: a job dir holds whole downloads. The bot and every worker share the
// base, so each process works under its own host dir and only age ever deletes another's.
const JOBS_BASE = path.resolve(process.env.MEDIA_TEMP_DIR || 'temp/jobs');
export const JOBS_ROOT = path.join(JOBS_BASE, os.hostname());
const HEAD_BYTES = 64;
const IDLE_TIMEOUT_MS = 60_000;
const scope = new AsyncLocalStorage();

export class TooLargeError extends Error {
  constructor(maxSize) {
    super(`file exceeds ${maxSize} bytes`);
    this.code = 'TOO_LARGE';
    this.maxSize = maxSize;
  }
}

async function newJobDir() {
  await fsp.mkdir(JOBS_ROOT, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(path.join(JOBS_ROOT, 'job-'));
}

// Runs fn with a job dir that every file created inside it lands in; the dir goes when fn settles.
// A signal cancels the job: every request and child process started inside it is aborted.
export async function withJobDir(fn, { signal } = {}) {
  if (scope.getStore()) return fn();
  const dir = await newJobDir();
  try {
    return await scope.run({ dir, signal }, () => withLogRef(path.basename(dir).slice(4), fn));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// The current job's cancel signal, combined with `extra` (e.g. a timeout) when both exist.
export function jobSignal(extra) {
  const signals = [scope.getStore()?.signal, extra].filter(Boolean);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

// Every axios request made inside a cancellable job stops with it.
axios.interceptors.request.use(config =>
  config.signal || !jobSignal() ? config : { ...config, signal: jobSignal() }
);

// Writes beside the final path, then renames, so a killed write never leaves a truncated file there.
export async function writeAtomic(finalPath, write) {
  const part = finalPath.replace(/(\.\w+)?$/, `.${randomBytes(6).toString('hex')}.part$1`);
  try {
    await write(part);
    await fsp.rename(part, finalPath);
  } catch (error) {
    await fsp.rm(part, { force: true });
    throw error;
  }
}

// Outside withJobDir (tests, scripts) a file gets its own dir, left for sweepJobDirs.
export async function tempPath(ext = '') {
  const dir = scope.getStore()?.dir ?? (await newJobDir());
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : '';
  return path.join(dir, `${randomBytes(8).toString('hex')}${safeExt}`);
}

export async function tempDir() {
  const dir = await tempPath();
  await fsp.mkdir(dir, { mode: 0o700 });
  return dir;
}

function meter(maxSize, onChunk = () => {}) {
  const hash = createHash('sha256');
  const state = { size: 0, head: Buffer.alloc(0) };
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      onChunk();
      state.size += chunk.length;
      if (state.size > maxSize) return callback(new TooLargeError(maxSize));
      hash.update(chunk);
      if (state.head.length < HEAD_BYTES) {
        state.head = Buffer.concat([state.head, chunk.subarray(0, HEAD_BYTES - state.head.length)]);
      }
      callback(null, chunk);
    },
  });
  return { stream, state, digest: () => hash.digest('hex') };
}

// Streams a readable to a new temp file, hashing on the way; nothing is held in memory.
export async function writeStream(
  readable,
  { ext = '', maxSize = Infinity, transforms = [] } = {}
) {
  const file = await tempPath(ext);
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => readable.destroy(new Error('download stalled')), IDLE_TIMEOUT_MS);
  };
  const m = meter(maxSize, touch);
  touch();
  try {
    await pipeline(readable, ...transforms, m.stream, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (error) {
    await fsp.rm(file, { force: true });
    throw error;
  } finally {
    clearTimeout(idle);
  }
  return { path: file, size: m.state.size, hash: m.digest(), head: m.state.head };
}

// GETs url straight to disk. axios's maxContentLength does not apply to streams, so the cap is ours.
export async function fetchToFile(url, options = {}, { maxSize = Infinity, ext = '' } = {}) {
  const response = await axios.get(url, { ...options, responseType: 'stream' });
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxSize) {
    response.data.destroy();
    throw new TooLargeError(maxSize);
  }
  const written = await writeStream(response.data, { ext, maxSize });
  return {
    ...written,
    headers: response.headers,
    contentType: response.headers['content-type'] || '',
  };
}

// Gives an item's file its filename's extension; tools like ffmpeg's image2 pick a demuxer by it.
export async function withExtension(item) {
  const ext = path.extname(item.filename ?? '').toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(ext) || path.extname(item.path) === ext) return item;
  const renamed = item.path.replace(/(\.[a-z0-9]{1,5})?$/i, ext);
  await fsp.rename(item.path, renamed);
  return { ...item, path: renamed };
}

// Hash and head of a file a tool already wrote.
export async function fromPath(file, meta = {}) {
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    if (size === 0) head = Buffer.from(chunk.subarray(0, HEAD_BYTES));
    size += chunk.length;
    hash.update(chunk);
  }
  return { ...meta, path: file, size, hash: hash.digest('hex'), head };
}

// Removes job dirs a crash left behind, in any process's host dir.
export async function sweepJobDirs(maxAgeMs = 6 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const hosts = await fsp.readdir(JOBS_BASE, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const host of hosts.filter(entry => entry.isDirectory())) {
    const hostDir = path.join(JOBS_BASE, host.name);
    const jobs = await fsp.readdir(hostDir, { withFileTypes: true }).catch(() => []);
    for (const job of jobs.filter(entry => entry.isDirectory())) {
      const dir = path.join(hostDir, job.name);
      const { mtimeMs } = await fsp.stat(dir).catch(() => ({ mtimeMs: Date.now() }));
      if (mtimeMs >= cutoff) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      removed++;
    }
    if (hostDir !== JOBS_ROOT && (await fsp.readdir(hostDir).catch(() => [1])).length === 0) {
      await fsp.rmdir(hostDir).catch(() => {});
    }
  }
  if (removed) logger.info(`Removed ${removed} stale job dir(s)`);
  return removed;
}
