import { test, describe, beforeAll, afterAll, mock } from 'bun:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { createFakeInteraction } from '../helpers/fake-interaction.js';

// Full-pipeline E2E for /convert and /optimize: only the network download is mocked, ffmpeg,
// gifsicle, storage, the database and the Discord reply path are real. See download-e2e for why
// the mocks are gated on GRONKA_E2E.
const mocksSupported = process.env.GRONKA_E2E === 'true';
const hasGifsicle = Boolean(Bun.which('gifsicle'));

const GIF_STORAGE_PATH = mocksSupported
  ? path.join(os.tmpdir(), `gronka-convert-e2e-${process.pid}-${Date.now()}`, 'gifs')
  : null;
if (mocksSupported) {
  process.env.GIF_STORAGE_PATH = GIF_STORAGE_PATH;
  process.env.CDN_BASE_URL = 'https://cdn.test/gifs';
}

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

const media = (buffer, contentType, filename) => ({
  buffer,
  contentType,
  size: buffer.length,
  filename,
});

function fixtureFor(url) {
  if (url.includes('longvid')) return media(fixtures.long, 'video/mp4', 'long.mp4');
  if (url.includes('vid')) return media(fixtures.mp4, 'video/mp4', 'clip.mp4');
  if (url.includes('anim')) return media(fixtures.gif, 'image/gif', 'anim.gif');
  if (url.includes('still')) return media(fixtures.png, 'image/png', 'still.png');
  return media(Buffer.from('<html></html>'), 'text/html', 'page.html');
}

function attachmentOf(kind) {
  const file = fixtureFor(kind);
  return {
    url: `https://cdn.discordapp.com/attachments/1/2/${kind}-${file.filename}`,
    name: file.filename,
    size: file.size,
    contentType: file.contentType,
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

    const real = { ...(await import('../../src/utils/file-downloader.js')) };
    mock.module('../../src/utils/file-downloader.js', () => ({
      ...real,
      downloadVideo: async url => fixtureFor(url).buffer,
      downloadImage: async url => fixtureFor(url).buffer,
      downloadFileFromUrl: async url => fixtureFor(url),
      parseTenorUrl: async url => url,
    }));

    ({ handleConvertCommand, handleConvertContextMenu } =
      await import('../../src/commands/convert.js'));
    ({ handleOptimizeCommand, handleOptimizeContextMenuCommand } =
      await import('../../src/commands/optimize.js'));
  });

  afterAll(async () => {
    mock.restore();
    await fs.rm(path.dirname(GIF_STORAGE_PATH), { recursive: true, force: true });
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

    test('url input: converted once, then served from the url cache', async () => {
      const url = `https://example.com/vid-${Date.now()}.mp4`;
      const discordUrl = 'https://cdn.discordapp.com/attachments/9/9/converted.gif';
      const first = commandInteraction(
        `cv-url-a-${Date.now()}`,
        { url },
        { messageAttachments: [{ url: discordUrl }] }
      );
      await handleConvertCommand(first.interaction);
      assert.ok(first.calls.editReply[0].files, 'first run attaches the gif');

      const second = commandInteraction(`cv-url-b-${Date.now()}`, { url });
      await handleConvertCommand(second.interaction);
      assert.strictEqual(second.calls.editReply[0].content, discordUrl);
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
      assert.ok(reply.content.includes('https://cdn.test/gifs/'), reply.content);
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

    test('url that is not media: refused as an unsupported format', async () => {
      const { interaction, calls } = commandInteraction(`cv-html-${Date.now()}`, {
        url: `https://example.com/page-${Date.now()}`,
      });
      await handleConvertCommand(interaction);
      assert.match(firstReply(calls).content, /unsupported file format/);
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

    test.skipIf(!hasGifsicle)(
      'gif url: optimized once, then served from the url cache',
      async () => {
        const url = `https://example.com/anim-${Date.now()}.gif`;
        const discordUrl = 'https://cdn.discordapp.com/attachments/9/9/optimized.gif';
        const first = commandInteraction(
          `op-url-a-${Date.now()}`,
          { url, lossy: 40 },
          { messageAttachments: [{ url: discordUrl }] }
        );
        await handleOptimizeCommand(first.interaction);
        assert.ok(first.calls.editReply[0].files, 'first run attaches the gif');

        const second = commandInteraction(`op-url-b-${Date.now()}`, { url, lossy: 40 });
        await handleOptimizeCommand(second.interaction);
        assert.strictEqual(second.calls.editReply[0].content, discordUrl);
      }
    );

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
