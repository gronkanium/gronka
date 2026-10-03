import { test, describe, beforeAll, afterAll, mock } from 'bun:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { createFakeInteraction } from '../helpers/fake-interaction.js';
import { mediaFromBytes } from '../helpers/media.js';

// Full-pipeline E2E for /convert and /optimize: only the network download is mocked, ffmpeg,
// gifsicle, storage, the database and the Discord reply path are real. See download-e2e for why
// the mocks are gated on GRONKA_E2E.
const mocksSupported = process.env.GRONKA_E2E === 'true';
const hasGifsicle = Boolean(Bun.which('gifsicle'));

const fixtures = {};
let handleConvertCommand;
let handleConvertContextMenu;
let handleOptimizeCommand;
let handleOptimizeContextMenuCommand;

function ffmpeg(args) {
  const run = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', ...args]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

function probeSeconds(buffer, ext) {
  const file = path.join(os.tmpdir(), `gronka-probe-${process.pid}-${Date.now()}${ext}`);
  fsSync.writeFileSync(file, buffer);
  const run = Bun.spawnSync([
    ...['ffprobe', '-v', 'error', '-show_entries', 'format=duration'],
    ...['-of', 'csv=p=0', file],
  ]);
  fsSync.rmSync(file, { force: true });
  return Number(run.stdout.toString().trim());
}

const media = (buffer, contentType, filename) =>
  mediaFromBytes(buffer, { contentType, filename, ext: path.extname(filename) });

const HTML = Buffer.from('<html></html>');

function fixtureMeta(url) {
  if (url.includes('longvid')) return { bytes: fixtures.long, type: 'video/mp4', name: 'long.mp4' };
  if (url.includes('vid')) return { bytes: fixtures.mp4, type: 'video/mp4', name: 'clip.mp4' };
  if (url.includes('anim')) return { bytes: fixtures.gif, type: 'image/gif', name: 'anim.gif' };
  if (url.includes('still')) return { bytes: fixtures.png, type: 'image/png', name: 'still.png' };
  return { bytes: HTML, type: 'text/html', name: 'page.html' };
}

function fixtureFor(url) {
  const { bytes, type, name } = fixtureMeta(url);
  return media(bytes, type, name);
}

function attachmentOf(kind) {
  const { bytes, type, name } = fixtureMeta(kind);
  return {
    url: `https://cdn.discordapp.com/attachments/1/2/${kind}-${name}`,
    name,
    size: bytes.length,
    contentType: type,
  };
}

function commandInteraction(userId, values = {}, fake = {}) {
  const { interaction, calls } = createFakeInteraction({ deferred: false, userId, ...fake });
  interaction.options = {
    getAttachment: name => values[name] ?? null,
    getString: name => values[name] ?? null,
    getBoolean: name => values[name] ?? null,
    getNumber: name => values[name] ?? null,
  };
  return { interaction, calls };
}

function contextInteraction(userId, commandName, attachments, content = '') {
  const { interaction, calls } = createFakeInteraction({ deferred: false, userId });
  interaction.commandName = commandName;
  interaction.isMessageContextMenuCommand = () => true;
  interaction.targetMessage = { attachments, content };
  calls.showModal = [];
  interaction.showModal = async modal => {
    calls.showModal.push(modal);
  };
  return { interaction, calls };
}

const firstReply = calls => calls.editReply[0] ?? calls.reply[0];

if (!mocksSupported) {
  describe('convert and optimize (full-pipeline E2E)', () => {
    test('skipped: module mocks are e2e-only (run via bun run test:e2e)', () => {
      assert.ok(true);
    });
  });
} else {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gronka-convert-media-'));
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=6'],
      ...['-f', 'lavfi', '-i', 'sine=duration=6', '-shortest'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', `${dir}/clip.mp4`],
    ]);
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=1:duration=40'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${dir}/long.mp4`],
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=5:duration=6', `${dir}/anim.gif`]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x32', '-frames:v', '1', `${dir}/still.png`]);
    for (const [key, file] of Object.entries({
      mp4: 'clip.mp4',
      long: 'long.mp4',
      gif: 'anim.gif',
      png: 'still.png',
    })) {
      fixtures[key] = await fs.readFile(`${dir}/${file}`);
    }
    await fs.rm(dir, { recursive: true, force: true });

    const realR2 = await import('../../src/utils/r2-storage.js');
    mock.module('../../src/utils/r2-storage.js', () => ({
      ...realR2,
      isR2Configured: () => true,
      uploadMediaToR2: async (type, file, ext) =>
        `https://cdn.test/${realR2.newMediaKey(type, ext)}`,
    }));

    const real = { ...(await import('../../src/utils/file-downloader.js')) };
    mock.module('../../src/utils/file-downloader.js', () => ({
      ...real,
      downloadVideo: async url => fixtureFor(url),
      downloadImage: async url => fixtureFor(url),
      downloadFileFromUrl: async url => fixtureFor(url),
      downloadDirectMedia: async url => fixtureFor(url),
      parseTenorUrl: async url => url,
    }));

    const realYtdlp = await import('../../src/utils/ytdlp.js');
    mock.module('../../src/utils/ytdlp.js', () => ({
      ...realYtdlp,
      downloadWithYtdlp: async () => media(fixtures.mp4, 'video/mp4', 'yt.mp4'),
    }));

    ({ handleConvertCommand, handleConvertContextMenu } =
      await import('../../src/commands/convert.js'));
    ({ handleOptimizeCommand, handleOptimizeContextMenuCommand } =
      await import('../../src/commands/optimize.js'));
  });

  afterAll(() => {
    mock.restore();
  });

  const isGif = buffer => buffer.subarray(0, 3).toString() === 'GIF';

  describe('/convert (full-pipeline E2E)', () => {
    test('video attachment: converted and attached as a gif', async () => {
      const { interaction, calls } = commandInteraction(`cv-video-${Date.now()}`, {
        file: attachmentOf('vid'),
      });
      await handleConvertCommand(interaction);
      const [file] = firstReply(calls).files;
      assert.ok(file.name.endsWith('.gif'));
      assert.ok(isGif(file.attachment));
    });

    test('video attachment with start and end: the gif covers only that range', async () => {
      const { interaction, calls } = commandInteraction(`cv-trim-${Date.now()}`, {
        file: attachmentOf('vid'),
        start: '1',
        end: '3',
      });
      await handleConvertCommand(interaction);
      const [file] = firstReply(calls).files;
      const seconds = probeSeconds(file.attachment, '.gif');
      assert.ok(seconds > 1.5 && seconds < 2.6, `~2s gif, got ${seconds}`);
    });

    test('still image attachment: converted to a gif', async () => {
      const { interaction, calls } = commandInteraction(`cv-png-${Date.now()}`, {
        file: attachmentOf('still'),
      });
      await handleConvertCommand(interaction);
      const [file] = firstReply(calls).files;
      assert.ok(isGif(file.attachment));
    });

    test.skipIf(!hasGifsicle)(
      'gif attachment with optimize: an optimized gif comes back',
      async () => {
        const { interaction, calls } = commandInteraction(`cv-opt-${Date.now()}`, {
          file: attachmentOf('anim'),
          optimize: true,
        });
        await handleConvertCommand(interaction);
        const [file] = firstReply(calls).files;
        assert.ok(isGif(file.attachment));
      }
    );

    test('url input: converted fresh every time, nothing is cached', async () => {
      const url = `https://example.com/vid-${Date.now()}.mp4`;
      for (const user of ['a', 'b']) {
        const { interaction, calls } = commandInteraction(`cv-url-${user}-${Date.now()}`, { url });
        await handleConvertCommand(interaction);
        assert.ok(isGif(calls.editReply[0].files[0].attachment), `run ${user} attaches a gif`);
      }
    });

    test('youtube url: fetched through yt-dlp, not as the watch page', async () => {
      const { interaction, calls } = commandInteraction(`cv-yt-${Date.now()}`, {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
      await handleConvertCommand(interaction);
      assert.ok(isGif(calls.editReply[0].files[0].attachment));
    });

    test('gif over the attachment limit: replies with a CDN link', async () => {
      const { interaction, calls } = commandInteraction(`cv-big-${Date.now()}`, {
        file: attachmentOf('vid'),
        start: '0',
        end: '4',
      });
      interaction.attachmentSizeLimit = 100;
      await handleConvertCommand(interaction);
      const reply = firstReply(calls);
      assert.strictEqual(reply.files, undefined);
      assert.match(reply.content, /https:\/\/cdn\.test\/gifs\/[0-9a-f]{32}\.gif/);
    });

    test('video longer than the gif limit: refused with the length in the message', async () => {
      const { interaction, calls } = commandInteraction(`cv-long-${Date.now()}`, {
        url: `https://example.com/longvid-${Date.now()}.mp4`,
      });
      await handleConvertCommand(interaction);
      assert.match(firstReply(calls).content, /video is too long \(40s\)/);
    });

    test('format mp3: the audio track comes back as an mp3 attachment', async () => {
      const { interaction, calls } = commandInteraction(`cv-mp3-${Date.now()}`, {
        file: attachmentOf('vid'),
        format: 'mp3',
      });
      await handleConvertCommand(interaction);
      assert.ok(firstReply(calls).files[0].name.endsWith('.mp3'));
    });

    test('both a file and a url: refused', async () => {
      const { interaction, calls } = commandInteraction(`cv-both-${Date.now()}`, {
        file: attachmentOf('vid'),
        url: 'https://example.com/vid.mp4',
      });
      await handleConvertCommand(interaction);
      assert.match(calls.reply[0].content, /not both/);
    });

    test('url that is not media: refused, and the failure keeps only the site', async () => {
      const since = Date.now();
      const { interaction, calls } = commandInteraction(`cv-html-${since}`, {
        url: `https://example.com/page-${since}`,
      });
      await handleConvertCommand(interaction);
      assert.match(firstReply(calls).content, /unsupported file format/);

      const { getAlerts } = await import('../../src/utils/database.js');
      const [alert] = await getAlerts({ command: 'convert', startTime: since, limit: 1 });
      assert.ok(alert, 'the refusal is recorded as a failure');
      const metadata = JSON.parse(alert.metadata);
      assert.strictEqual(metadata.source, 'example.com');
      assert.ok(!JSON.stringify(alert).includes(`page-${since}`), 'never the link itself');
      assert.ok(!('user_id' in alert) && !('operation_id' in alert));
    });

    test('context menu on a message with a video: converted to a gif', async () => {
      const { interaction, calls } = contextInteraction(`cv-ctx-${Date.now()}`, 'convert to gif', [
        attachmentOf('vid'),
      ]);
      await handleConvertContextMenu(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });
  });

  describe('/optimize (full-pipeline E2E)', () => {
    test.skipIf(!hasGifsicle)('gif attachment: optimized gif attached', async () => {
      const { interaction, calls } = commandInteraction(`op-gif-${Date.now()}`, {
        file: attachmentOf('anim'),
      });
      await handleOptimizeCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test('non-gif attachment: refused', async () => {
      const { interaction, calls } = commandInteraction(`op-png-${Date.now()}`, {
        file: attachmentOf('still'),
      });
      await handleOptimizeCommand(interaction);
      assert.strictEqual(calls.reply[0].content, 'this command only works on gif files.');
    });

    test('lossy out of range: refused before any work', async () => {
      const { interaction, calls } = commandInteraction(`op-lossy-${Date.now()}`, {
        file: attachmentOf('anim'),
        lossy: 101,
      });
      await handleOptimizeCommand(interaction);
      assert.strictEqual(calls.reply[0].content, 'lossy level must be between 0 and 100.');
    });

    test.skipIf(!hasGifsicle)('gif url: optimized on every run, nothing is cached', async () => {
      const url = `https://example.com/anim-${Date.now()}.gif`;
      for (const run of ['a', 'b']) {
        const { interaction, calls } = commandInteraction(`op-url-${run}-${Date.now()}`, {
          url,
          lossy: 40,
        });
        await handleOptimizeCommand(interaction);
        assert.ok(calls.editReply[0].files, `run ${run} attaches a freshly optimized gif`);
      }
    });

    test('context menu on a gif: asks for the lossy level in a modal', async () => {
      const cache = new Map();
      const { interaction, calls } = contextInteraction(`op-ctx-${Date.now()}`, 'optimize', [
        attachmentOf('anim'),
      ]);
      await handleOptimizeContextMenuCommand(interaction, cache);
      assert.strictEqual(calls.showModal.length, 1);
      assert.strictEqual(cache.size, 1);
    });
  });
}
