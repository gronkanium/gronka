import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import fsSync from 'fs';
import path from 'path';
import { mock } from 'node:test';
import * as realChildProcess from 'child_process';

// Exercises the retry-on-generic-failure behavior in ytdlp.js's executeYtdlpWithRetry.
// spawn() is mocked at the module level so this runs without a real yt-dlp binary or network
// access, which requires --experimental-test-module-mocks (provided by the test:e2e npm script).
const mocksSupported = typeof mock.module === 'function';

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

if (!mocksSupported) {
  describe('yt-dlp generic-failure retry', () => {
    test('skipped: requires --experimental-test-module-mocks (run via npm run test:e2e)', () => {
      assert.ok(true);
    });
  });
} else {
  let downloadWithYtdlp;

  // Reconfigured per-test: an array of (child, outputDir) => void functions, one per
  // successive spawn() call.
  let spawnBehaviors;
  let spawnCallLog;

  before(async () => {
    mock.module('child_process', {
      namedExports: {
        // Other modules in the dependency chain (e.g. video-processor/utils.js) also import
        // from 'child_process' - pass everything else through untouched and only override spawn.
        ...realChildProcess,
        spawn: (cmd, args) => {
          const child = fakeChildProcess();
          const callNumber = spawnCallLog.push({});
          // executeYtdlp passes '-o', '<outputDir>/%(title)s.%(ext)s' - recover the real
          // per-call temp directory so a "successful" run can drop a file there.
          const outputTemplate = args[args.indexOf('-o') + 1];
          const outputDir = path.dirname(outputTemplate);
          setTimeout(() => {
            const behavior = spawnBehaviors[callNumber - 1];
            behavior(child, outputDir);
          });
          return child;
        },
      },
    });

    ({ downloadWithYtdlp } = await import('../../src/utils/ytdlp.js'));
  });

  after(() => {
    if (mocksSupported) {
      mock.restoreAll();
    }
  });

  function genericFailure(child) {
    child.stderr.emit('data', Buffer.from('completely unrecognized yt-dlp failure output'));
    child.emit('close', 1);
  }

  function rateLimitFailure(child) {
    child.stderr.emit('data', Buffer.from('ERROR: HTTP Error 429: Too Many Requests'));
    child.emit('close', 1);
  }

  function success(child, outputDir) {
    const outputFilePath = path.join(outputDir, 'video.mp4');
    // Must be >= 1KB - executeYtdlp treats smaller files as a failed download.
    fsSync.writeFileSync(outputFilePath, Buffer.alloc(2048, 1));
    child.stdout.emit('data', Buffer.from(outputFilePath + '\n'));
    child.emit('close', 0);
  }

  describe('yt-dlp generic-failure retry', () => {
    test('retries once and succeeds when the first attempt hits the generic failure bucket', async () => {
      spawnCallLog = [];
      spawnBehaviors = [genericFailure, success];

      const result = await downloadWithYtdlp(
        'https://youtu.be/retry-success',
        false,
        Infinity,
        null,
        Infinity, // skip the duration pre-check so it doesn't spawn an extra yt-dlp call
        null,
        null
      );

      assert.strictEqual(spawnCallLog.length, 2, 'expected exactly one retry (two spawn calls)');
      assert.ok(result.buffer.length > 0);
    });

    test('does not retry a confirmed-state failure (rate limit)', async () => {
      spawnCallLog = [];
      spawnBehaviors = [rateLimitFailure];

      await assert.rejects(
        () =>
          downloadWithYtdlp(
            'https://youtu.be/rate-limited',
            false,
            Infinity,
            null,
            Infinity,
            null,
            null
          ),
        error => error.name === 'YtdlpRateLimitError'
      );

      assert.strictEqual(spawnCallLog.length, 1, 'rate-limit failures should not be retried');
    });

    test('gives up after the retry also fails with the generic bucket', async () => {
      spawnCallLog = [];
      spawnBehaviors = [genericFailure, genericFailure];

      await assert.rejects(
        () =>
          downloadWithYtdlp(
            'https://youtu.be/still-failing',
            false,
            Infinity,
            null,
            Infinity,
            null,
            null
          ),
        error =>
          error.message ===
          'could not download this content. it may be deleted, private, age-restricted, or unsupported.'
      );

      assert.strictEqual(
        spawnCallLog.length,
        2,
        'expected exactly one retry attempt, then give up'
      );
    });
  });
}
