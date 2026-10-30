import path from 'path';
import { createLogger } from '../utils/logger.js';
import { describeCause, rootCause } from '../utils/errors.js';
import { withJobDir } from '../utils/media-file.js';
import { detectFileType } from '../utils/storage.js';
import { readSetting } from '../utils/settings.js';
import {
  saveSourceCheck,
  listSourceChecks,
  pruneSourceChecks,
} from '../utils/database/source-checks-pg.js';
import { acquireMedia } from './acquire-media.js';
import { SOURCE_EXAMPLES } from './source-examples.js';

const logger = createLogger('source-checks');

const DAY_MS = 24 * 60 * 60 * 1000;
const GONE = ['CONTENT_GONE', 'CLIP_NOT_PUBLISHED'];

const describeExpect = ({ type, count }) => (count > 1 ? `${count} ${type}` : type);

function mediaOf(result) {
  if (result.kind === 'urls') {
    return result.urls.map(u => (u.type === 'photo' ? 'image' : u.type));
  }
  return [result.fileData]
    .flat()
    .map(file =>
      file.archive
        ? 'archive'
        : detectFileType(path.extname(file.filename ?? ''), file.contentType ?? '', file.head)
    );
}

// What came back, as one string like "video" or "3 image" or "image, video".
export function describeMedia(types) {
  const kinds = [...new Set(types)];
  if (kinds.length === 1) return describeExpect({ type: kinds[0], count: types.length });
  return types.join(', ');
}

export function verdict(expect, types) {
  const wantCount = expect.count ?? 1;
  const ok = types.length === wantCount && types.every(type => type === expect.type);
  return ok ? 'pass' : 'fail';
}

export async function checkExample(example, { acquire = acquireMedia } = {}) {
  const started = Date.now();
  const base = { url: example.url, site: example.site, expected: describeExpect(example.expect) };
  try {
    const types = await withJobDir(async () =>
      mediaOf(await acquire(example.url, { urlOnly: false }))
    );
    return {
      ...base,
      status: verdict(example.expect, types),
      got: describeMedia(types),
      cause: null,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      status: GONE.includes(error.code) ? 'gone' : 'fail',
      got: null,
      cause: `${error.message} (${describeCause(rootCause(error))})`,
      ms: Date.now() - started,
    };
  }
}

export async function runAndSave(example) {
  const result = await checkExample(example);
  await saveSourceCheck({ ...result, at: Date.now() });
  if (result.status !== 'pass') {
    logger.warn(`Source check ${result.status}: ${example.url}: ${result.cause ?? result.got}`);
  }
  return result;
}

let running = false;
export const isRunning = () => running;

const pause = () => new Promise(resolve => setTimeout(resolve, 20_000 + Math.random() * 40_000));

// One link at a time with a pause between, so no site sees a burst from us.
export async function runSourceChecks({ wait = pause } = {}) {
  if (running) return null;
  running = true;
  const tally = { pass: 0, fail: 0, gone: 0 };
  try {
    await pruneSourceChecks(SOURCE_EXAMPLES.map(e => e.url));
    for (const [index, example] of SOURCE_EXAMPLES.entries()) {
      if (index > 0) await wait();
      tally[(await runAndSave(example)).status]++;
    }
    logger.info(`Source checks: ${tally.pass} pass, ${tally.fail} fail, ${tally.gone} gone`);
    return tally;
  } finally {
    running = false;
  }
}

export function startSourceCheckJob(intervalMs = 60 * 60 * 1000) {
  const tick = async () => {
    try {
      if (!(await readSetting('source_checks'))) return;
      const checked = new Map((await listSourceChecks()).map(row => [row.url, row.checkedAt]));
      const due = SOURCE_EXAMPLES.some(e => Date.now() - (checked.get(e.url) ?? 0) >= DAY_MS);
      if (!due) return;
      await runSourceChecks();
    } catch (error) {
      logger.error(`Source check run failed: ${error.message}`, error);
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
