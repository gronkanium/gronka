import express from 'express';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { jobsOverview, jobsForOperation } from '../../utils/database/media-jobs-pg.js';
import { getLiveBytes, getStorageOverview, lastLogMatching } from '../../utils/database.js';
import { getPostgresConnection } from '../../utils/database/connection.js';
import { r2SoftLimitGb } from '../../utils/r2-storage.js';
import { readSessions } from '../sessions.js';
import pkg from '../../../package.json' with { type: 'json' };

const logger = createLogger('webui');
const router = express.Router();
const execFileAsync = promisify(execFile);
const GB = 1024 ** 3;

// One dependency row: never throws, a failure is the row's status.
async function check(id, label, probe) {
  try {
    return { id, label, status: 'ok', ...(await probe(Date.now())) };
  } catch (error) {
    return { id, label, status: 'error', detail: error.message };
  }
}

async function disk() {
  const s = await fs.statfs(botConfig.gifStoragePath);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

let ytdlpVersion;
const probes = {
  postgres: async started => {
    await getPostgresConnection()`SELECT 1`;
    return { detail: `${Date.now() - started} ms` };
  },
  cobalt: async started => {
    const res = await fetch(botConfig.cobaltApiUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { cobalt } = await res.json();
    return { detail: `v${cobalt.version} · ${Date.now() - started} ms` };
  },
  ytdlp: async () => {
    ytdlpVersion ??= (
      await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 })
    ).stdout.trim();
    return { detail: ytdlpVersion };
  },
  r2: async () => {
    const [bytes, limitGb] = await Promise.all([getLiveBytes(Date.now()), r2SoftLimitGb()]);
    const limit = limitGb > 0 ? limitGb * GB : 0;
    return {
      status: limit && bytes > limit * 0.9 ? 'warn' : 'ok',
      detail: limit ? `${Math.round((bytes / limit) * 100)}% of ${limitGb} GB` : 'no limit set',
    };
  },
  disk: async () => {
    const { free, total } = await disk();
    return {
      status: free / total < 0.1 ? 'warn' : 'ok',
      detail: `${Math.round(free / GB)} GB free of ${Math.round(total / GB)} GB`,
    };
  },
};
const LABELS = {
  postgres: 'Postgres',
  cobalt: 'cobalt',
  ytdlp: 'yt-dlp',
  r2: 'R2 storage',
  disk: 'Local disk',
};

router.get('/api/system', async (req, res) => {
  try {
    res.json({
      jobs: await jobsOverview(),
      mediaWorkers: process.env.MEDIA_WORKERS !== 'false',
      version: pkg.version,
    });
  } catch (error) {
    logger.error('Failed to read job queue:', error);
    res.status(500).json({ error: 'failed to read job queue' });
  }
});

router.get('/api/system/jobs/:operationId', async (req, res) => {
  try {
    res.json({ jobs: await jobsForOperation(req.params.operationId) });
  } catch (error) {
    logger.error('Failed to read jobs for operation:', error);
    res.status(500).json({ error: 'failed to read jobs' });
  }
});

router.get('/api/system/deps', async (req, res) => {
  const [deps, sessions] = await Promise.all([
    Promise.all(Object.entries(probes).map(([id, probe]) => check(id, LABELS[id], probe))),
    readSessions({
      cookiesPath: process.env.INSTAGRAM_COOKIES_PATH,
      jarPath: process.env.YTDLP_COOKIES_PATH,
      lastRejected: lastLogMatching,
    }).catch(error => {
      logger.error('Failed to read session files:', error);
      return [];
    }),
  ]);
  res.json({ deps, sessions });
});

router.get('/api/storage', async (req, res) => {
  try {
    const [r2, limitGb, space] = await Promise.all([
      getStorageOverview(),
      r2SoftLimitGb().catch(error => {
        logger.warn(`R2 soft limit read failed: ${error.message}`);
        return 0;
      }),
      disk().catch(error => {
        logger.warn(`Disk usage read failed: ${error.message}`);
        return null;
      }),
    ]);
    res.json({ r2, limitBytes: limitGb > 0 ? limitGb * GB : 0, disk: space });
  } catch (error) {
    logger.error('Failed to read storage overview:', error);
    res.status(500).json({ error: 'failed to read storage' });
  }
});

export default router;
