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
    test('the failure keeps yt-dlp ERROR line as its cause', async () => {
      const failing = child => {
        child.stderr.emit(
          'data',
          Buffer.from(
            '[instagram:story] x: Downloading\nERROR: [instagram:story] You need to log in\n'
          )
        );
        child.emit('close', 1);
      };
      spawnCallLog = [];
      spawnBehaviors = [failing, failing];
      const error = await downloadWithYtdlp('https://youtu.be/needs-login', {
        maxSize: Infinity,
        maxDuration: Infinity,
      }).catch(caught => caught);
      assert.strictEqual(
        error.cause.message,
        'yt-dlp: ERROR: [instagram:story] You need to log in'
      );
    });

    test('retries once and succeeds when the first attempt hits the generic failure bucket', async () => {
      spawnCallLog = [];
      spawnBehaviors = [genericFailure, success];

      const result = await downloadWithYtdlp('https://youtu.be/retry-success', {
        maxSize: Infinity,
        maxDuration: Infinity,
      });

      assert.strictEqual(spawnCallLog.length, 2, 'expected exactly one retry (two spawn calls)');
      assert.ok(result.size > 0);
    });

    test('does not retry a confirmed-state failure (rate limit)', async () => {
      spawnCallLog = [];
      spawnBehaviors = [rateLimitFailure];

      await assert.rejects(
        () =>
          downloadWithYtdlp('https://youtu.be/rate-limited', {
            maxSize: Infinity,
            maxDuration: Infinity,
          }),
        error => error.name === 'YtdlpRateLimitError'
      );

      assert.strictEqual(spawnCallLog.length, 1, 'rate-limit failures should not be retried');
    });

    test('gives up after the retry also fails with the generic bucket', async () => {
      spawnCallLog = [];
      spawnBehaviors = [genericFailure, genericFailure];

      await assert.rejects(
        () =>
          downloadWithYtdlp('https://youtu.be/still-failing', {
            maxSize: Infinity,
            maxDuration: Infinity,
          }),
        error =>
          error.code === 'YTDLP_UNKNOWN' &&
          error.message === 'could not download this YouTube link.'
      );

      assert.strictEqual(
        spawnCallLog.length,
        2,
        'expected exactly one retry attempt, then give up'
      );
    });
  });

  describe('TikTok video missing from the local CDN', () => {
    function missingCopy(child) {
      child.stderr.emit(
        'data',
        Buffer.from('ERROR: unable to download video data: HTTP Error 404: Not Found')
      );
      child.emit('close', 1);
    }
    const url = 'https://www.tiktok.com/@a/video/7667652642516028679';

    test('retries once through the geo proxy, without the session cookies', async () => {
      process.env.GEO_PROXY_URL = 'http://vpn:8888';
      const jar = path.join(process.cwd(), 'temp', 'test-cookies.txt');
      fsSync.mkdirSync(path.dirname(jar), { recursive: true });
      fsSync.writeFileSync(jar, '# Netscape HTTP Cookie File\n');
      const savedJar = process.env.YTDLP_COOKIES_PATH;
      process.env.YTDLP_COOKIES_PATH = jar;
      spawnCallLog = [];
      spawnBehaviors = [missingCopy, success];
      try {
        const result = await downloadWithYtdlp(url, { maxSize: Infinity, maxDuration: Infinity });
        assert.ok(result.size > 0);
      } finally {
        delete process.env.GEO_PROXY_URL;
        if (savedJar === undefined) delete process.env.YTDLP_COOKIES_PATH;
        else process.env.YTDLP_COOKIES_PATH = savedJar;
        fsSync.rmSync(jar, { force: true });
      }
      assert.strictEqual(spawnCallLog.length, 2);
      assert.ok(!spawnCallLog[0].args.includes('--proxy'));
      assert.ok(spawnCallLog[0].args.includes('--cookies'));
      assert.ok(spawnCallLog[1].args.includes('--proxy'));
      assert.ok(!spawnCallLog[1].args.includes('--cookies'));
    });

    test('fails with a curated message when no geo proxy is set', async () => {
      spawnCallLog = [];
      spawnBehaviors = [missingCopy];
      await assert.rejects(
        () => downloadWithYtdlp(url, { maxSize: Infinity, maxDuration: Infinity }),
        error => error.code === 'REGION_COPY_MISSING'
      );
      assert.strictEqual(spawnCallLog.length, 1);
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
          downloadWithYtdlp('https://www.instagram.com/p/DbpZVohPsMX/', {
            maxSize: Infinity,
            maxDuration: Infinity,
          }),
        error => error.message === 'this post has no video in it.'
      );
    });

    test('other hosts keep the formats message', async () => {
      spawnCallLog = [];
      spawnBehaviors = [noVideoFormats];

      await assert.rejects(
        () =>
          downloadWithYtdlp('https://youtu.be/no-formats', {
            maxSize: Infinity,
            maxDuration: Infinity,
          }),
        error => error.message === 'no downloadable video formats found'
      );
    });
  });

  describe('failures yt-dlp names get a reason instead of the catch-all', () => {
    function failsWith(text) {
      return child => {
        child.stderr.emit('data', Buffer.from(text));
        child.emit('close', 1);
      };
    }

    const cases = [
      [
        'ERROR: [youtube] abc: Join this channel to get access to members-only content',
        'https://youtu.be/members',
        'this video is members-only',
      ],
      [
        'ERROR: [TikTok] 123: Your IP address is blocked from accessing this post',
        'https://www.tiktok.com/@a/video/123',
        'this post is unavailable, it may be deleted or private',
      ],
      [
        'ERROR: [facebook] 123: Cannot parse data; please report this issue',
        'https://www.facebook.com/watch/?v=123',
        'facebook.com changed its page and cannot be read yet.',
      ],
      [
        'ERROR: Unsupported URL: https://www.tiktok.com/discover/thing',
        'https://www.tiktok.com/discover/thing',
        'this link is not a downloadable video page.',
        'YTDLP_UNSUPPORTED_URL',
      ],
      [
        'ERROR: [MedalTV] abc: Unable to download JSON metadata: HTTP Error 403: Forbidden',
        'https://medal.tv/games/x/clips/abc',
        'this medal clip is still being published, try again in a minute.',
        'CLIP_NOT_PUBLISHED',
      ],
    ];

    for (const [stderr, url, expected, code] of cases) {
      test(expected, async () => {
        spawnCallLog = [];
        spawnBehaviors = [failsWith(stderr)];

        await assert.rejects(
          () => downloadWithYtdlp(url, { maxSize: Infinity, maxDuration: Infinity }),
          error => error.message === expected && (!code || error.code === code)
        );
      });
    }

    test('a sign-in demand is retried once before it reaches the user', async () => {
      spawnCallLog = [];
      spawnBehaviors = [failsWith('ERROR: [youtube] abc: Please sign in. Use --cookies'), success];

      const result = await downloadWithYtdlp('https://youtu.be/signin', {
        maxSize: Infinity,
        maxDuration: Infinity,
      });
      assert.ok(result);
      assert.strictEqual(spawnCallLog.length, 2);
    });

    for (const apostrophe of ["'", '’']) {
      test(`a bot challenge with ${apostrophe} switches to the signed-in client`, async () => {
        spawnCallLog = [];
        spawnBehaviors = [
          failsWith(`ERROR: [youtube] abc: Sign in to confirm you${apostrophe}re not a bot.`),
          success,
        ];

        const result = await downloadWithYtdlp('https://youtu.be/challenge', {
          maxSize: Infinity,
          maxDuration: Infinity,
        });
        assert.ok(result.size > 0);
        assert.strictEqual(spawnCallLog.length, 2);
        assert.ok(spawnCallLog[0].args.includes('youtube:player_client=default'));
        assert.ok(spawnCallLog[1].args.includes('youtube:player_client=web_embedded,default'));
      });
    }
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
      child.stdout.emit('data', Buffer.from('NA NA\n'));
      child.emit('close', 0);
    }

    test('a stream that is still live is refused before downloading', async () => {
      spawnCallLog = [];
      spawnBehaviors = [
        child => {
          child.stdout.emit('data', Buffer.from('is_live NA\n'));
          child.emit('close', 0);
        },
      ];
      await assert.rejects(
        () =>
          downloadWithYtdlp('https://www.youtube.com/live/abc', {
            maxSize: Infinity,
            maxDuration: 3600,
          }),
        error => error.code === 'STREAM_IS_LIVE'
      );
      assert.strictEqual(spawnCallLog.length, 1);
    });

    test('passes the optional-duration form so unknown-duration media still downloads', async () => {
      spawnCallLog = [];
      spawnBehaviors = [unknownDuration, success];

      const result = await downloadWithYtdlp(
        'https://gif.fxtwitter.com/tweet_video/HNOvuGAXoAAAIQO.webp',
        { maxSize: Infinity, maxDuration: 3600 }
      );

      const downloadArgs = spawnCallLog[1].args;
      const filterValue = downloadArgs[downloadArgs.indexOf('--match-filter') + 1];
      assert.strictEqual(
        filterValue,
        'duration<=?3600',
        'the `?` must sit on the operator, or yt-dlp drops every unknown-duration item'
      );
      assert.ok(result.size > 0, 'the download should still produce a file');
    });

    test('the format selector accepts formats that report no height', async () => {
      spawnCallLog = [];
      spawnBehaviors = [unknownDuration, success];

      await downloadWithYtdlp('https://gif.fxtwitter.com/tweet_video/HNOvuGAXoAAAIQO.webp', {
        maxSize: Infinity,
        maxDuration: 3600,
      });

      const downloadArgs = spawnCallLog[1].args;
      const format = downloadArgs[downloadArgs.indexOf('-f') + 1];
      assert.ok(!/height<=\d/.test(format), `format selector must use height<=?N, got: ${format}`);
      assert.ok(format.includes('height<=?1080'), `expected a 1080p cap, got: ${format}`);
    });
  });
}
