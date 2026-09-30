import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { mock } from 'bun:test';
import { createFakeInteraction } from '../helpers/fake-interaction.js';
import { mediaFromBytes } from '../helpers/media.js';
import { setSetting } from '../../src/utils/database.js';

// Full-pipeline E2E for the download command. The network boundary (Cobalt / yt-dlp / file
// downloader) is mocked at the module level so these run without any real HTTP, but everything
// else is real: the runMediaCommand lifecycle, URL validation, storage (local disk), database
// (test postgres), hash-based dedup, and, critically, the Discord reply path that the unit
// tests cannot reach.
//
// We drive handleDownloadCommand (the public slash-command entry point) so the test also
// exercises deferral, URL validation, and the social-media-platform check. download.js is
// imported dynamically AFTER the mocks are registered, since mock.module only affects imports
// that resolve after the mock is registered.
//
// `bun test` runs every file in ONE process and mock.module() is process-global, so this file
// must not register its cobalt/ytdlp/file-downloader mocks during the plain test:safe run -
// they would leak into every other file importing those modules. GRONKA_E2E is set only by
// the test:e2e script.
const mocksSupported = process.env.GRONKA_E2E === 'true';

// Each run gets its own throwaway storage directory so filesystem-level cache logic is
// exercised identically for every test. Must be set BEFORE importing download.js because
// botConfig reads GIF_STORAGE_PATH at module load time. Only required when mocks are active.
const GIF_STORAGE_PATH = mocksSupported
  ? path.join(os.tmpdir(), `gronka-e2e-${process.pid}-${Date.now()}`)
  : null;
if (mocksSupported) {
  process.env.GIF_STORAGE_PATH = GIF_STORAGE_PATH;
  // The cache-reply assertion exercises the configured CDN path; CI has no .env file.
  process.env.CDN_BASE_URL = 'https://cdn.test/gifs';
}

function fakeBuffer(seed, size = 1024) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed + i) & 0xff;
  }
  return buf;
}

let handleDownloadCommand;
let getProcessedUrl;
let hashUrl;
const fixtures = {};

function ffmpeg(args) {
  const run = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', ...args]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

function probeSeconds(buffer, ext) {
  const file = path.join(os.tmpdir(), `gronka-probe-${process.pid}-${Date.now()}${ext}`);
  fsSync.writeFileSync(file, buffer);
  const run = Bun.spawnSync([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  fsSync.rmSync(file, { force: true });
  return Number(run.stdout.toString().trim());
}

if (!mocksSupported) {
  // No --experimental-test-module-mocks: register a single skipped placeholder so the file is
  // visible in the suite but does not fail the main test:safe run.
  describe('handleDownloadCommand (full-pipeline E2E)', () => {
    test('skipped: module mocks are e2e-only (run via bun run test:e2e)', () => {
      assert.ok(true);
    });
  });
} else {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gronka-e2e-media-'));
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=6'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${dir}/clip.mp4`],
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=5:duration=6', `${dir}/anim.gif`]);
    fixtures.mp4 = await fs.readFile(`${dir}/clip.mp4`);
    fixtures.gif = await fs.readFile(`${dir}/anim.gif`);
    await fs.rm(dir, { recursive: true, force: true });
    const media = (buffer, contentType, filename) =>
      mediaFromBytes(buffer, { contentType, filename, ext: path.extname(filename) });

    // Register mocks for the network boundary BEFORE importing download.js.
    mock.module('../../src/utils/cobalt.js', () => ({
      canonicalizeMirrorUrl: url => url,
      isSocialMediaUrl: url => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(url),
      // Reached via the twitter_delivery policy (default hybrid probes every
      // X/Twitter URL), url_only_mode (no test enables it), or the direct-URL
      // fallback for downloads that failed (e.g. over the size/duration caps).
      getCobaltMediaUrls: async (_apiUrl, url) => {
        if (url.includes('toolong')) {
          return {
            urls: [
              {
                url: 'https://video.twimg.com/ext_tw_video/toolong/vid/avc1/full.mp4',
                type: 'video',
                filename: null,
              },
            ],
            direct: true,
          };
        }
        if (url.includes('huge')) {
          return {
            urls: [
              {
                url: 'https://video.twimg.com/ext_tw_video/huge/vid/avc1/big.mp4',
                type: 'video',
                filename: null,
              },
            ],
            direct: true,
          };
        }
        const { NetworkError } = await import('../../src/utils/errors.js');
        throw new NetworkError('this post is unavailable or has been deleted');
      },
      // Size probe used by the hybrid delivery mode: 'huge' URLs report a size
      // over the Discord attachment limit, everything else is tiny.
      getRemoteContentLength: async mediaUrl =>
        mediaUrl.includes('huge') ? 50 * 1024 * 1024 : 4096,
      downloadFromSocialMedia: async (_apiUrl, url) => {
        // A carousel bigger than Discord's 10-attachment ceiling, to exercise batching.
        if (url.includes('carousel')) {
          return Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              media(fakeBuffer(i + 1, 2048 + i), 'image/png', `photo_${i + 1}.png`)
            )
          );
        }
        if (url.includes('multi')) {
          return Promise.all([
            media(fakeBuffer(1, 2048), 'image/png', 'photo_1.png'),
            media(fakeBuffer(2, 3072), 'image/png', 'photo_2.png'),
          ]);
        }
        if (url.includes('trimvid')) return media(fixtures.mp4, 'video/mp4', 'clip.mp4');
        if (url.includes('trimgif')) return media(fixtures.gif, 'image/gif', 'anim.gif');
        if (url.includes('gifnamed')) return media(fixtures.mp4, 'video/mp4', 'loop.gif');
        if (url.includes('onephoto')) return media(fakeBuffer(9, 2048), 'image/png', 'one.png');
        if (url.includes('deleted')) {
          const { NetworkError } = await import('../../src/utils/errors.js');
          throw new NetworkError('this post is unavailable or has been deleted');
        }
        if (url.includes('toolong')) {
          const { ValidationError } = await import('../../src/utils/errors.js');
          throw new ValidationError('file is too large (max 100mb)');
        }
        if (url.includes('huge')) {
          // The hybrid delivery mode must serve the direct URL for oversized
          // videos WITHOUT downloading - reaching this mock is a test failure.
          throw new Error(
            'downloadFromSocialMedia must not be called for huge videos in hybrid mode'
          );
        }
        return media(fakeBuffer(3, 4096), 'video/mp4', 'clip.mp4');
      },
    }));

    mock.module('../../src/utils/ytdlp.js', () => ({
      getYtdlpSite: () => null,
      getCookieArgs: () => [],
      // download-services.js builds its registry from this table at import time.
      YTDLP_SITES: [
        { name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
        { name: 'RedGifs', hosts: ['redgifs.com'] },
        { name: 'XVideos', hosts: ['xvideos.com'] },
      ],
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
        return media(fakeBuffer(4, 4096), 'video/mp4', 'clip.mp4');
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
        if (u.includes('toolong')) {
          const { ValidationError } = await import('../../src/utils/errors.js');
          throw new ValidationError(
            'video duration exceeds the maximum allowed (5 minutes).' +
              ' use the start and end options to grab a clip under the limit.'
          );
        }
        return media(fakeBuffer(4, 4096), 'video/mp4', 'clip.mp4');
      },
      YtdlpRateLimitError: class YtdlpRateLimitError extends Error {},
    }));

    mock.module('../../src/utils/file-downloader.js', () => ({
      downloadVideo: async () => media(fakeBuffer(5, 4096), 'video/mp4', 'clip.mp4'),
      downloadImage: async () => media(fakeBuffer(6, 4096), 'image/png', 'still.png'),
      downloadFileFromUrl: async () => media(fakeBuffer(7, 4096), 'video/mp4', 'clip.mp4'),
      parseTenorUrl: async u => u,
      isDirectMediaUrl: () => false,
      downloadDirectMedia: async () => media(fakeBuffer(8, 4096), 'video/mp4', 'direct.mp4'),
    }));

    // Dynamically import AFTER mocks are in place so the mocked modules are used.
    ({ handleDownloadCommand } = await import('../../src/commands/download.js'));
    ({ getProcessedUrl } = await import('../../src/utils/database.js'));
    ({ hashUrl } = await import('../../src/utils/hashing.js'));
  });

  afterAll(async () => {
    mock.restore();
    await fs.rm(GIF_STORAGE_PATH, { recursive: true, force: true });
  });

  async function cleanStorage() {
    const base = path.resolve(GIF_STORAGE_PATH);
    await fs.rm(path.join(base, 'videos'), { recursive: true, force: true });
    await fs.rm(path.join(base, 'images'), { recursive: true, force: true });
    await fs.rm(path.join(base, 'gifs'), { recursive: true, force: true });
  }

  function downloadInteraction(url, userId = 'e2e-user', { start = null, end = null } = {}) {
    const { interaction, calls } = createFakeInteraction({ deferred: false, userId });
    const strings = { url, start, end };
    interaction.options = {
      getString: name => strings[name] ?? null,
      getBoolean: () => null,
      getNumber: () => null,
    };
    return { interaction, calls };
  }

  describe('handleDownloadCommand (full-pipeline E2E)', () => {
    test('single-file video: downloads, saves, and replies with a Discord attachment', async () => {
      await cleanStorage();
      // Unique URL to avoid colliding with a URL-cache entry persisted in gronka_test from a
      // prior run (tests share a long-lived DB, see TODO.md "postgres test DB persists").
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

    // Regression: Discord rejects a message carrying more than 10 attachments (50035), so a
    // 12-file carousel sent as one message failed entirely, the user got nothing, and the
    // operation was still recorded as a success.
    test('carousel over the attachment cap: splits across a reply plus follow-ups', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/carousel-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-carousel');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1, 'still exactly one reply edit');
      assert.strictEqual(calls.followUp.length, 1, 'the overflow goes out as a follow-up');

      const batches = [calls.editReply[0].files, ...calls.followUp.map(call => call.files)];
      assert.deepStrictEqual(
        batches.map(batch => batch.length),
        [10, 2],
        'no message may carry more than 10 attachments'
      );

      // Every file must still arrive, in order, the delivery split must not drop or reorder.
      const delivered = batches.flatMap(batch => batch.map(file => file.name));
      assert.strictEqual(delivered.length, 12, 'all 12 files delivered');
      assert.strictEqual(new Set(delivered).size, 12, 'no duplicated attachment');
      assert.ok(
        delivered.every(name => name.endsWith('.png')),
        'every delivered attachment is a .png'
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

    test('turned-off source: /download is refused with a curated message, no files', async () => {
      await cleanStorage();
      // Turn off the Twitter/X source, then attempt an x.com download.
      await setSetting('disabled_services', JSON.stringify(['twitter']));
      try {
        const url = `https://x.com/user/status/disabled-${Date.now()}`;
        const { interaction, calls } = downloadInteraction(url, 'e2e-dl-disabled');

        await handleDownloadCommand(interaction);

        assert.strictEqual(calls.editReply.length, 1, 'exactly one reply');
        assert.strictEqual(
          calls.editReply[0].content,
          'downloads from Twitter / X are turned off.'
        );
        assert.strictEqual(calls.editReply[0].files, undefined, 'no files when the source is off');
      } finally {
        await setSetting('disabled_services', '[]');
      }
    });

    test('hybrid delivery: oversized X/Twitter video is served as a direct URL with no download', async () => {
      await cleanStorage();
      // getRemoteContentLength reports 50MB (over the Discord limit), so the hybrid
      // twitter_delivery policy must reply with the direct URL; the download mock
      // throws if reached, proving no bytes were transferred.
      const url = `https://x.com/user/status/huge-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-huge');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1, 'exactly one reply');
      assert.strictEqual(
        calls.editReply[0].content,
        'https://video.twimg.com/ext_tw_video/huge/vid/avc1/big.mp4',
        'reply is the direct media URL'
      );
      assert.strictEqual(calls.editReply[0].files, undefined, 'no attachment');
    });

    test('too-long X/Twitter video: falls back to the direct media URL, no files', async () => {
      await cleanStorage();
      // Cobalt download fails (too large), yt-dlp fallback fails (duration cap), so the
      // command should hand out the direct video.twimg.com URL from cobalt instead of erroring.
      const url = `https://x.com/user/status/toolong-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-toolong');

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1, 'exactly one reply');
      assert.strictEqual(
        calls.editReply[0].content,
        'https://video.twimg.com/ext_tw_video/toolong/vid/avc1/full.mp4',
        'reply is the direct media URL'
      );
      assert.strictEqual(calls.editReply[0].files, undefined, 'no attachment');
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

    test('trimmed video: ffmpeg cuts the requested range and sends an mp4', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/trimvid-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-trimvid', {
        start: '1',
        end: '3',
      });

      await handleDownloadCommand(interaction);

      const [file] = calls.editReply[0].files;
      assert.ok(file.name.endsWith('.mp4'));
      const seconds = probeSeconds(file.attachment, '.mp4');
      assert.ok(seconds > 1.5 && seconds < 2.6, `trimmed to ~2s, got ${seconds}`);
    });

    test('trimmed gif: cut and sent back as a gif', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/trimgif-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-trimgif', {
        start: '1',
        end: '3',
      });

      await handleDownloadCommand(interaction);

      const [file] = calls.editReply[0].files;
      assert.ok(file.name.endsWith('.gif'));
      const seconds = probeSeconds(file.attachment, '.gif');
      assert.ok(seconds > 1.5 && seconds < 2.6, `trimmed to ~2s, got ${seconds}`);
    });

    test('mp4 served under a .gif name: trimmed into a real gif', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/gifnamed-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-gifnamed', {
        start: '1',
        end: '3',
      });

      await handleDownloadCommand(interaction);

      const [file] = calls.editReply[0].files;
      assert.ok(file.name.endsWith('.gif'));
      assert.strictEqual(file.attachment.subarray(0, 3).toString(), 'GIF');
    });

    test('trim ffmpeg cannot do: the untrimmed file is still delivered', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/badtrim-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-badtrim', { start: '1' });

      await handleDownloadCommand(interaction);

      const [file] = calls.editReply[0].files;
      assert.ok(file.name.endsWith('.mp4'));
      assert.strictEqual(file.attachment.length, 4096, 'original bytes');
    });

    test('single image: sent as an attachment with its own extension', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/onephoto-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-onephoto');

      await handleDownloadCommand(interaction);

      assert.ok(calls.editReply[0].files[0].name.endsWith('.png'));
      const row = await getProcessedUrl(hashUrl(url));
      assert.strictEqual(row.file_type, 'image');
    });

    test('file over the attachment limit: replies with a CDN link and records it', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/over-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-over');
      interaction.attachmentSizeLimit = 1000;

      await handleDownloadCommand(interaction);

      assert.strictEqual(calls.editReply.length, 1);
      assert.strictEqual(calls.editReply[0].files, undefined, 'no attachment');
      assert.ok(calls.editReply[0].content.includes('https://cdn.test/videos/'));
      const row = await getProcessedUrl(hashUrl(url));
      assert.strictEqual(row.file_type, 'video');
      assert.ok(row.file_url.startsWith('https://cdn.test/videos/'));
    });

    test('gallery with one oversized item: small one attaches, big one becomes a link', async () => {
      await cleanStorage();
      const url = `https://x.com/user/status/multi-split-${Date.now()}`;
      const { interaction, calls } = downloadInteraction(url, 'e2e-dl-multisplit');
      interaction.attachmentSizeLimit = 2500;

      await handleDownloadCommand(interaction);

      const reply = calls.editReply[0];
      assert.strictEqual(reply.files.length, 1, 'only the 2048-byte photo attaches');
      assert.ok(reply.content.includes('https://cdn.test/images/'), 'the 3072-byte one is a link');
    });
  });
}
