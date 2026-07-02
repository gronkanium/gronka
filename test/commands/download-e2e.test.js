import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { mock } from 'node:test';
import { createFakeInteraction } from '../helpers/fake-interaction.js';

// Full-pipeline E2E for the download command. The network boundary (Cobalt / yt-dlp / file
// downloader) is mocked at the module level so these run without any real HTTP, but everything
// else is real: the runMediaCommand lifecycle, URL validation, storage (local disk), database
// (test postgres), hash-based dedup, and — critically — the Discord reply path that the unit
// tests cannot reach.
//
// We drive handleDownloadCommand (the public slash-command entry point) so the test also
// exercises deferral, URL validation, and the social-media-platform check. download.js is
// imported dynamically AFTER the mocks are registered, since node:test's mock.module only
// affects imports that resolve after the mock is registered.

// This file requires --experimental-test-module-mocks (provided by the test:e2e npm script).
// When run under the plain test:safe suite (no mock flag), skip the whole suite gracefully.
const mocksSupported = typeof mock.module === 'function';

// Each run gets its own throwaway storage directory so filesystem-level cache logic is
// exercised identically for every test. Must be set BEFORE importing download.js because
// botConfig reads GIF_STORAGE_PATH at module load time. Only required when mocks are active.
const GIF_STORAGE_PATH = mocksSupported
  ? path.join(os.tmpdir(), `gronka-e2e-${process.pid}-${Date.now()}`)
  : null;
if (mocksSupported) process.env.GIF_STORAGE_PATH = GIF_STORAGE_PATH;

function fakeBuffer(seed, size = 1024) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed + i) & 0xff;
  }
  return buf;
}

let handleDownloadCommand;

if (!mocksSupported) {
  // No --experimental-test-module-mocks: register a single skipped placeholder so the file is
  // visible in the suite but does not fail the main test:safe run.
  describe('handleDownloadCommand (full-pipeline E2E)', () => {
    test('skipped: requires --experimental-test-module-mocks (run via npm run test:e2e)', () => {
      assert.ok(true);
    });
  });
} else {
  before(async () => {
    // Register mocks for the network boundary BEFORE importing download.js.
    mock.module('../../src/utils/cobalt.js', {
      namedExports: {
        isSocialMediaUrl: url => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(url),
        // Only reached when the url_only_mode DB setting is on; no test enables it,
        // so throw loudly if a code change starts routing through it unexpectedly.
        getCobaltMediaUrls: async () => {
          throw new Error(
            'getCobaltMediaUrls should not be called (url_only_mode is off in tests)'
          );
        },
        downloadFromSocialMedia: async (_apiUrl, url) => {
          if (url.includes('multi')) {
            return [
              {
                buffer: fakeBuffer(1, 2048),
                contentType: 'image/png',
                size: 2048,
                filename: 'photo_1.png',
              },
              {
                buffer: fakeBuffer(2, 3072),
                contentType: 'image/png',
                size: 3072,
                filename: 'photo_2.png',
              },
            ];
          }
          if (url.includes('deleted')) {
            const { NetworkError } = await import('../../src/utils/errors.js');
            throw new NetworkError('this post is unavailable or has been deleted');
          }
          return {
            buffer: fakeBuffer(3, 4096),
            contentType: 'video/mp4',
            size: 4096,
            filename: 'clip.mp4',
          };
        },
      },
    });

    mock.module('../../src/utils/ytdlp.js', {
      namedExports: {
        isYouTubeUrl: () => false,
        downloadFromYouTube: async (
          _url,
          _admin,
          _maxSize,
          _quality,
          _maxDuration,
          _startTime,
          _duration
        ) => {
          // yt-dlp is only used as a fallback when Cobalt fails for X/Twitter URLs.
          // If the URL was deleted, the failure should propagate (not magically succeed).
          const u = _url || '';
          if (u.includes('deleted')) {
            const { NetworkError } = await import('../../src/utils/errors.js');
            throw new NetworkError('this post is unavailable or has been deleted');
          }
          return {
            buffer: fakeBuffer(4, 4096),
            contentType: 'video/mp4',
            size: 4096,
            filename: 'clip.mp4',
          };
        },
        downloadWithYtdlp: async (
          _url,
          _admin,
          _maxSize,
          _quality,
          _maxDuration,
          _startTime,
          _duration
        ) => {
          const u = _url || '';
          if (u.includes('deleted')) {
            const { NetworkError } = await import('../../src/utils/errors.js');
            throw new NetworkError('this post is unavailable or has been deleted');
          }
          return {
            buffer: fakeBuffer(4, 4096),
            contentType: 'video/mp4',
            size: 4096,
            filename: 'clip.mp4',
          };
        },
        YtdlpRateLimitError: class YtdlpRateLimitError extends Error {},
      },
    });

    mock.module('../../src/utils/file-downloader.js', {
      namedExports: {
        generateHash: buf => {
          // BLAKE3 via noble would be real; use a stable synthetic hash for test.
          let h = 0;
          for (let i = 0; i < Math.min(buf.length, 64); i++) {
            h = (h * 31 + buf[i]) >>> 0;
          }
          return h.toString(16).padStart(64, '0');
        },
        downloadVideo: async () => fakeBuffer(5, 4096),
        downloadImage: async () => fakeBuffer(6, 4096),
        downloadFileFromUrl: async () => ({
          buffer: fakeBuffer(7, 4096),
          contentType: 'video/mp4',
          size: 4096,
          filename: 'clip.mp4',
        }),
        parseTenorUrl: async u => u,
      },
    });

    // Dynamically import AFTER mocks are in place so the mocked modules are used.
    ({ handleDownloadCommand } = await import('../../src/commands/download.js'));
  });

  after(async () => {
    if (mocksSupported) {
      mock.restoreAll();
      await fs.rm(GIF_STORAGE_PATH, { recursive: true, force: true });
    }
  });

  async function cleanStorage() {
    const base = path.resolve(GIF_STORAGE_PATH);
    await fs.rm(path.join(base, 'videos'), { recursive: true, force: true });
    await fs.rm(path.join(base, 'images'), { recursive: true, force: true });
    await fs.rm(path.join(base, 'gifs'), { recursive: true, force: true });
  }

  function downloadInteraction(url, userId = 'e2e-user') {
    const { interaction, calls } = createFakeInteraction({ deferred: false, userId });
    interaction.options = {
      getString: name => (name === 'url' ? url : null),
      getNumber: () => null,
    };
    return { interaction, calls };
  }

  describe('handleDownloadCommand (full-pipeline E2E)', () => {
    test('single-file video: downloads, saves, and replies with a Discord attachment', async () => {
      await cleanStorage();
      // Unique URL to avoid colliding with a URL-cache entry persisted in gronka_test from a
      // prior run (tests share a long-lived DB — see TODO.md "postgres test DB persists").
      const url = `https://x.com/user/status/single-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-single');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.deferReply.length, 1, 'handler defers the reply');
      assert.strictEqual(calls.editReply.length, 1, 'exactly one reply');
      const reply = calls.editReply[0];
      assert.ok(reply.files, 'reply includes files (Discord attachment path)');
      assert.strictEqual(reply.files.length, 1);
      assert.ok(reply.files[0].name.endsWith('.mp4'), 'attachment has .mp4 filename');
      assert.strictEqual(reply.content, undefined, 'no URL content clobbering the attachment');
    });

    test('multi-file picker: downloads array and replies with multiple attachments', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/multi-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-multi');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1, 'exactly one reply');
      const reply = calls.editReply[0];
      assert.ok(reply.files, 'reply includes files');
      assert.strictEqual(reply.files.length, 2, 'two attachments for two photos');
      const names = reply.files.map(f => f.name);
      assert.ok(
        names.every(n => n.endsWith('.png')),
        'both attachments are .png'
      );
    });

    test('deleted post: curated error message reaches the user, no files', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/deleted-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-deleted');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1);
      assert.strictEqual(
        calls.editReply[0].content,
        'this post is unavailable or has been deleted'
      );
      assert.strictEqual(calls.editReply[0].files, undefined, 'no files on error');
    });

    test('second identical download hits the file cache and replies with a URL (no re-download)', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/cache-${Date.now()}`;
      const first = downloadInteraction(url, 'e2e-dl-cache-a');
      await handleDownloadCommand(first.interaction);
      assert.ok(first.calls.editReply[0].files, 'first download sends attachment');

      // Second download of the same URL by a different user: the file already exists on disk
      // (matched by content hash), so the command should skip the download and reply with a URL.
      const second = downloadInteraction(url, 'e2e-dl-cache-b');
      await handleDownloadCommand(second.interaction);

      assert.strictEqual(second.calls.editReply.length, 1);
      const content = second.calls.editReply[0].content;
      assert.ok(content, 'cache hit replies with a URL');
      assert.ok(content.includes('/videos/'), 'URL points to the videos CDN path');
    });
  });
}
