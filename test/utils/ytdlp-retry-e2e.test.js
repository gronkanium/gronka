import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import fsSync from 'fs';
import path from 'path';
import { mock } from 'bun:test';
import * as realChildProcess from 'child_process';

// Exercises the retry-on-generic-failure behavior in ytdlp.js's executeYtdlpWithRetry.
// spawn() is mocked at the module level so this runs without a real yt-dlp binary or network
// access.
//
// `bun test` runs every file in ONE process and mock.module() is process-global, so this file
// must not register its child_process mock during the plain test:safe run - it would leak into
// every other file that spawns. GRONKA_E2E is set only by the test:e2e script.
const mocksSupported = process.env.GRONKA_E2E === 'true';

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

if (!mocksSupported) {
  describe('yt-dlp generic-failure retry', () => {
    test('skipped: module mocks are e2e-only (run via bun run test:e2e)', () => {
      assert.ok(true);
    });
  });
} else {
  let downloadWithYtdlp;

  // Reconfigured per-test: an array of (child, outputDir) => void functions, one per
  // successive spawn() call.
  let spawnBehaviors;
  let spawnCallLog;

  beforeAll(async () => {
    const childProcessMock = () => ({
      // Other modules in the dependency chain (e.g. video-processor/utils.js) also import
      // from 'child_process' - pass everything else through untouched and only override spawn.
      ...realChildProcess,
      spawn: (cmd, args) => {
        const child = fakeChildProcess();
        const callNumber = spawnCallLog.push({ args });
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
    });
    // Bun resolves bare 'child_process' and 'node:child_process' to distinct module records,
    // so both specifiers need the mock for it to catch every importer.
    mock.module('child_process', childProcessMock);
    mock.module('node:child_process', childProcessMock);

    ({ downloadWithYtdlp } = await import('../../src/utils/ytdlp.js'));
  });

  afterAll(() => {
    mock.restore();
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

  // yt-dlp reports an Instagram photo post as a formats problem, which read to users as a bot
  // failure on a post that simply has no video. Every production occurrence was an /p/ link.
  describe('Instagram photo posts blame the post, not the formats', () => {
    function noVideoFormats(child) {
      child.stderr.emit(
        'data',
        Buffer.from('ERROR: [Instagram] abc123: No video formats found!; please report this issue')
      );
      child.emit('close', 1);
    }

    test('an instagram /p/ permalink reports that the post has no video', async () => {
      spawnCallLog = [];
      spawnBehaviors = [noVideoFormats];

      await assert.rejects(
        () =>
          downloadWithYtdlp(
            'https://www.instagram.com/p/DbpZVohPsMX/',
            false,
            Infinity,
            null,
            Infinity,
            null,
            null
          ),
        error => error.message === 'this post has no video in it.'
      );
    });

    test('other hosts keep the formats message', async () => {
      spawnCallLog = [];
      spawnBehaviors = [noVideoFormats];

      await assert.rejects(
        () =>
          downloadWithYtdlp(
            'https://youtu.be/no-formats',
            false,
            Infinity,
            null,
            Infinity,
            null,
            null
          ),
        error => error.message === 'no downloadable video formats found'
      );
    });
  });

  // Regression: a direct-media link (e.g. an animated webp from gif.fxtwitter.com) goes through
  // yt-dlp's generic extractor, which reports no duration. A plain `duration <= N` match-filter
  // rejects unknown-duration items outright, so yt-dlp skipped the file, exited 0 with no output,
  // and the no-output fallback reported "video duration exceeds the maximum allowed (60 minutes)"
  // for a two-second gif. The `?` on the operator makes the field optional.
  describe('duration match-filter treats an unknown duration as passing', () => {
    // First spawn is the duration pre-check (`--print duration`); yt-dlp prints "NA" when the
    // extractor has no duration. Second spawn is the real download.
    function unknownDuration(child) {
      child.stdout.emit('data', Buffer.from('NA\n'));
      child.emit('close', 0);
    }

    test('passes the optional-duration form so unknown-duration media still downloads', async () => {
      spawnCallLog = [];
      spawnBehaviors = [unknownDuration, success];

      const result = await downloadWithYtdlp(
        'https://gif.fxtwitter.com/tweet_video/HNOvuGAXoAAAIQO.webp',
        false,
        Infinity,
        null,
        3600,
        null,
        null
      );

      const downloadArgs = spawnCallLog[1].args;
      const filterValue = downloadArgs[downloadArgs.indexOf('--match-filter') + 1];
      assert.strictEqual(
        filterValue,
        'duration<=?3600',
        'the `?` must sit on the operator, or yt-dlp drops every unknown-duration item'
      );
      assert.ok(result.buffer.length > 0, 'the download should still produce a file');
    });

    test('the non-admin format selector accepts formats that report no height', async () => {
      spawnCallLog = [];
      spawnBehaviors = [unknownDuration, success];

      await downloadWithYtdlp(
        'https://gif.fxtwitter.com/tweet_video/HNOvuGAXoAAAIQO.webp',
        false,
        Infinity,
        null,
        3600,
        null,
        null
      );

      const downloadArgs = spawnCallLog[1].args;
      const format = downloadArgs[downloadArgs.indexOf('-f') + 1];
      assert.ok(
        !/height<=\d/.test(format),
        `non-admin format selector must use height<=?N, got: ${format}`
      );
      assert.ok(format.includes('height<=?1080'), `expected a 1080p cap, got: ${format}`);
    });
  });
}
