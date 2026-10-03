import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { createLogger, formatTimestampSeconds, withLogRef } from '../../src/utils/logger.js';

// Console is the only place a line goes; capture it.
async function captured(fn) {
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('logger', () => {
  test('formatTimestampSeconds drops milliseconds', () => {
    assert.strictEqual(
      formatTimestampSeconds(new Date('2026-01-02T03:04:05.678Z')),
      '2026-01-02T03:04:05Z'
    );
  });

  test('writes a formatted line to the console, never anywhere else', async () => {
    const lines = await captured(() => createLogger('t').warn('disk is low', { free: 1 }));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /\[WARN \] disk is low \{"free":1\}$/);
  });

  test('respects the level it was created with', async () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'WARN';
    try {
      const logger = createLogger('t');
      const lines = await captured(async () => {
        await logger.info('hidden');
        await logger.debug('hidden');
        await logger.error('shown');
      });
      assert.deepStrictEqual(
        lines.map(l => l.includes('shown')),
        [true]
      );
    } finally {
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    }
  });

  test('an Error keeps its message and stack', async () => {
    const lines = await captured(() => createLogger('t').error('failed:', new Error('boom')));
    assert.match(lines[0], /failed: Error: boom/);
  });

  test('a link never reaches the log, only its site', async () => {
    const lines = await captured(() =>
      createLogger('t').warn('yt-dlp: https://www.youtube.com/watch?v=abc failed', {
        at: 'https://x.com/someone/status/1',
      })
    );
    assert.match(lines[0], /yt-dlp: youtube\.com failed \{"at":"x\.com"\}$/);
  });

  test('a line inside a job carries its reference', async () => {
    const lines = await captured(() => withLogRef('ab12cd', () => createLogger('t').warn('hi')));
    assert.match(lines[0], /\[WARN \] \[ab12cd\] hi$/);
  });
});
