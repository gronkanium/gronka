import { test, describe, beforeAll, afterAll, mock } from 'bun:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { Client, MessageFlags } from 'discord.js';
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
let runMediaJob;
let JOBS_ROOT;
let handleConvertInteraction;
const fetches = new Map();
const publicReplies = new Map();

const restClient = new Client({ intents: [] });
restClient.rest.patch = async (route, { body, files = [] }) => {
  const calls = [...publicReplies].find(([token]) => route.includes(token))?.[1];
  assert.ok(calls, `unexpected Discord edit: ${route}`);
  calls.editReply.push({
    ...body,
    ...(files.length
      ? {
          files: files.map((file, i) => ({
            name: body.attachments?.[i]?.filename ?? file.name,
            attachment: file.data,
          })),
        }
      : {}),
  });
  return { id: 'public-reply', attachments: [] };
};

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
  if (url.includes('brokenvid')) return { bytes: HTML, type: 'video/mp4', name: 'broken.mp4' };
  if (url.includes('awebp'))
    return { bytes: fixtures.awebp, type: 'image/webp', name: 'animation.webp' };
  if (url.includes('flac')) return { bytes: fixtures.flac, type: 'audio/flac', name: 'track.flac' };
  if (url.includes('covered'))
    return { bytes: fixtures.covered, type: 'audio/flac', name: 'artwork.flac' };
  if (url.includes('wav')) return { bytes: fixtures.wav, type: 'audio/wav', name: 'track.wav' };
  if (url.includes('longvid')) return { bytes: fixtures.long, type: 'video/mp4', name: 'long.mp4' };
  if (url.includes('vid')) return { bytes: fixtures.mp4, type: 'video/mp4', name: 'clip.mp4' };
  if (url.includes('anim')) return { bytes: fixtures.gif, type: 'image/gif', name: 'anim.gif' };
  if (url.includes('still')) return { bytes: fixtures.png, type: 'image/png', name: 'still.png' };
  return { bytes: HTML, type: 'text/html', name: 'page.html' };
}

function fixtureFor(url) {
  fetches.set(url, (fetches.get(url) ?? 0) + 1);
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
  values = { format: 'gif', ...values };
  const { interaction, calls } = createFakeInteraction({ deferred: false, userId, ...fake });
  interaction.client = restClient;
  interaction.applicationId = 'fake-app';
  interaction.token = `command-${userId}`;
  interaction.createdTimestamp = Date.now();
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
  interaction.client = restClient;
  interaction.applicationId = 'fake-app';
  interaction.token = `context-${userId}`;
  interaction.createdTimestamp = Date.now();
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

async function pickerFor(calls) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const message = calls.editReply.find(reply => reply.components?.length);
    if (message) return JSON.parse(JSON.stringify(message));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`picker was not shown: ${JSON.stringify(calls)}`);
}

function pickerInteraction(menu, format, { cancel = false, ephemeral = true } = {}) {
  const { interaction, calls } = createFakeInteraction({ deferred: false });
  interaction.customId = menu.components[cancel ? 1 : 0].components[0].custom_id;
  interaction.applicationId = 'fake-app';
  interaction.token = `choice-${Date.now()}-${Math.random()}`;
  interaction.createdTimestamp = Date.now();
  interaction.client = restClient;
  interaction.values = [format];
  interaction.message = { flags: { has: flag => ephemeral && flag === MessageFlags.Ephemeral } };
  interaction.isStringSelectMenu = () => !cancel;
  interaction.isButton = () => cancel;
  interaction.deferUpdate = async () => {
    interaction.deferred = true;
  };
  publicReplies.set(interaction.token, calls);
  return { interaction, calls };
}

async function chooseFrom(calls, work, format = 'gif') {
  const menu = await pickerFor(calls);
  const selected = pickerInteraction(menu, format);
  await handleConvertInteraction(selected.interaction);
  await work;
  return { ...selected, menu };
}

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
    ffmpeg([
      '-i',
      `${dir}/anim.gif`,
      '-c:v',
      'libwebp_anim',
      '-loop',
      '0',
      `${dir}/animation.webp`,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=32x32', '-frames:v', '1', `${dir}/still.png`]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=6', '-c:a', 'flac', `${dir}/track.flac`]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=6', '-c:a', 'pcm_s16le', `${dir}/track.wav`]);
    ffmpeg([
      '-i',
      `${dir}/track.flac`,
      '-i',
      `${dir}/still.png`,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'flac',
      '-c:v',
      'png',
      '-disposition:v',
      'attached_pic',
      `${dir}/covered.flac`,
    ]);
    for (const [key, file] of Object.entries({
      mp4: 'clip.mp4',
      long: 'long.mp4',
      gif: 'anim.gif',
      awebp: 'animation.webp',
      png: 'still.png',
      flac: 'track.flac',
      wav: 'track.wav',
      covered: 'covered.flac',
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
      downloadAudio: async url => fixtureFor(url),
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
    ({ runMediaJob } = await import('../../src/jobs/run-job.js'));
    ({ JOBS_ROOT } = await import('../../src/utils/media-file.js'));
    ({ handleConvertInteraction } = await import('../../src/commands/convert-picker.js'));
  });

  afterAll(() => {
    mock.restore();
  });

  const isGif = buffer => buffer.subarray(0, 3).toString() === 'GIF';

  describe('/convert (full-pipeline E2E)', () => {
    test('damaged media gets a curated error while its source and probe cause remain diagnosable', async () => {
      const since = Date.now();
      const attachment = attachmentOf('brokenvid');
      const { interaction, calls } = commandInteraction('cv-broken', {
        file: attachment,
        format: null,
      });
      await handleConvertCommand(interaction);
      assert.match(firstReply(calls).content, /could not read that media file/);
      assert.doesNotMatch(firstReply(calls).content, /ffprobe|moov atom|\/tmp\/|Invalid data/);
      const { getAlerts } = await import('../../src/utils/database.js');
      const alert = (await getAlerts({ command: 'convert', startTime: since }))[0];
      assert.ok(alert);
      const metadata = JSON.parse(alert.metadata);
      assert.strictEqual(metadata.url, attachment.url);
      assert.match(metadata.cause, /probe|invalid data|moov atom/i);
    });

    test('animated WebP offers video outputs and keeps the animation when converted to MP4', async () => {
      const { interaction, calls } = commandInteraction('cv-awebp', {
        file: attachmentOf('awebp'),
        format: null,
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction), 'mp4');
      assert.ok(
        selected.menu.components[0].components[0].options.some(option => option.value === 'mp4')
      );
      const seconds = probeSeconds(firstReply(selected.calls).files[0].attachment, '.mp4');
      assert.ok(seconds > 5.5 && seconds < 6.5);
    });

    test('omitting format shows a private picker and posts the selected GIF publicly without another download', async () => {
      const attachment = attachmentOf('vid-picker');
      const before = fetches.get(attachment.url) ?? 0;
      const { interaction, calls } = commandInteraction('cv-picker', {
        file: attachment,
        format: null,
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction));
      assert.strictEqual(calls.deferReply[0].flags, MessageFlags.Ephemeral);
      assert.ok(
        selected.menu.components[0].components[0].options.some(option => option.value === 'gif')
      );
      assert.strictEqual(selected.calls.deferReply[0].flags, undefined);
      assert.ok(isGif(firstReply(selected.calls).files[0].attachment));
      assert.strictEqual(fetches.get(attachment.url) - before, 1);
    });

    test('FLAC input offers only audio outputs and converts to a trimmed MP3', async () => {
      const { interaction, calls } = commandInteraction('cv-flac', {
        file: attachmentOf('flac'),
        format: null,
        start: '1',
        end: '3',
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction), 'mp3');
      assert.deepStrictEqual(
        selected.menu.components[0].components[0].options.map(option => option.value).sort(),
        ['flac', 'm4a', 'mp3', 'ogg', 'wav']
      );
      const file = firstReply(selected.calls).files[0];
      assert.ok(file.name.endsWith('.mp3'));
      const seconds = probeSeconds(file.attachment, '.mp3');
      assert.ok(seconds > 1.9 && seconds < 2.2);
    });

    test('silent video has no audio choices and cancelling leaves no media, job or alert', async () => {
      const before = (await fs.readdir(JOBS_ROOT).catch(() => [])).filter(name =>
        name.startsWith('job-')
      );
      const since = Date.now();
      const { interaction, calls } = commandInteraction('cv-cancel', {
        file: attachmentOf('longvid'),
        format: null,
      });
      const work = handleConvertCommand(interaction);
      const menu = await pickerFor(calls);
      assert.ok(!menu.components[0].components[0].options.some(option => option.value === 'mp3'));
      const selected = pickerInteraction(menu, null, { cancel: true });
      await handleConvertInteraction(selected.interaction);
      await work;
      assert.strictEqual(calls.editReply.at(-1).content, 'conversion cancelled.');
      assert.deepStrictEqual(
        (await fs.readdir(JOBS_ROOT)).filter(name => name.startsWith('job-')),
        before
      );
      const { jobsOverview } = await import('../../src/utils/database/media-jobs-pg.js');
      assert.strictEqual((await jobsOverview()).recent.length, 0);
      const { getAlerts } = await import('../../src/utils/database.js');
      assert.strictEqual((await getAlerts({ command: 'convert', startTime: since })).length, 0);
    });

    test('embedded cover art remains audio and cannot offer video or GIF', async () => {
      const { interaction, calls } = commandInteraction('cv-cover', {
        file: attachmentOf('covered'),
        format: null,
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction), 'wav');
      assert.ok(
        selected.menu.components[0].components[0].options.every(option =>
          ['mp3', 'm4a', 'ogg', 'wav', 'flac'].includes(option.value)
        )
      );
      assert.ok(firstReply(selected.calls).files[0].name.endsWith('.wav'));
    });

    test('audio input with an explicit format bypasses the picker', async () => {
      const { interaction, calls } = commandInteraction('cv-wav', {
        file: attachmentOf('wav'),
        format: 'flac',
      });
      await handleConvertCommand(interaction);
      assert.ok(firstReply(calls).files[0].name.endsWith('.flac'));
      assert.ok(calls.editReply.every(reply => !reply.components?.length));
    });

    test('a duplicate selection produces exactly one converted file', async () => {
      const { interaction, calls } = commandInteraction('cv-duplicate', {
        file: attachmentOf('flac'),
        format: null,
      });
      const work = handleConvertCommand(interaction);
      const menu = await pickerFor(calls);
      const a = pickerInteraction(menu, 'mp3');
      const b = pickerInteraction(menu, 'wav');
      await Promise.all([
        handleConvertInteraction(a.interaction),
        handleConvertInteraction(b.interaction),
      ]);
      await work;
      const deliveries = [...a.calls.editReply, ...b.calls.editReply].filter(
        reply => reply.files?.length
      );
      assert.strictEqual(deliveries.length, 1);
    });

    test('a failed Discord selection gets a curated error and the picker can still be retried', async () => {
      const { interaction, calls } = commandInteraction('cv-choice-failed', {
        file: attachmentOf('flac'),
        format: null,
      });
      const work = handleConvertCommand(interaction);
      const menu = await pickerFor(calls);
      const failed = pickerInteraction(menu, 'mp3');
      failed.interaction.guild = { members: { me: {} } };
      failed.interaction.channel.permissionsFor = () => ({ has: () => true });
      failed.interaction.fetchReply = async () => {
        throw new Error('Discord HTTP 503 from /webhooks/internal-token');
      };
      await handleConvertInteraction(failed.interaction);
      assert.strictEqual(
        firstReply(failed.calls).content,
        'could not select that format. please try again.'
      );
      const selected = await chooseFrom(calls, work, 'mp3');
      assert.ok(firstReply(selected.calls).files[0].name.endsWith('.mp3'));
    });

    test('picker expiry removes its job and files; a later click receives a private expiry message', async () => {
      const before = (await fs.readdir(JOBS_ROOT)).filter(name => name.startsWith('job-'));
      const { interaction, calls } = commandInteraction('cv-expire', {
        file: attachmentOf('vid'),
        format: null,
      });
      const work = handleConvertCommand(interaction);
      const menu = await pickerFor(calls);
      const [, , id, token] = menu.components[0].components[0].custom_id.split(':');
      const { publishConvertPicker } = await import('../../src/utils/database/media-jobs-pg.js');
      await publishConvertPicker(id, token, ['gif'], Date.now() - 1);
      await work;
      assert.match(calls.editReply.at(-1).content, /expired/);
      assert.deepStrictEqual(
        (await fs.readdir(JOBS_ROOT)).filter(name => name.startsWith('job-')),
        before
      );
      const selected = pickerInteraction(menu, 'gif');
      await handleConvertInteraction(selected.interaction);
      assert.match(selected.calls.reply[0].content, /expired/);
      assert.strictEqual(selected.calls.reply[0].flags, MessageFlags.Ephemeral);
    });

    test('a public prefix picker checks the invoking message author without storing a user id', async () => {
      const { interaction, calls } = commandInteraction('cv-owner', {
        file: attachmentOf('vid'),
        format: null,
      });
      interaction.isPrefixCommand = true;
      interaction.channelId = 'prefix-channel';
      interaction.message = { id: 'prefix-source', author: interaction.user };
      interaction.replyMessageId = () => 'prefix-placeholder';
      const work = handleConvertCommand(interaction);
      const menu = await pickerFor(calls);
      const selected = pickerInteraction(menu, 'gif', { ephemeral: false });
      selected.interaction.channel.messages.fetch = async () => interaction.message;
      selected.interaction.user.id = 'someone-else';
      await handleConvertInteraction(selected.interaction);
      assert.match(selected.calls.reply[0].content, /only the person/);
      const [, , id, token] = selected.interaction.customId.split(':');
      const { getConvertPicker } = await import('../../src/utils/database/media-jobs-pg.js');
      const job = await getConvertPicker(id, token);
      assert.ok(
        !JSON.stringify({ args: job.args, reply: job.reply }).includes(interaction.user.id)
      );
      const owner = pickerInteraction(menu, 'gif', { ephemeral: false });
      owner.interaction.user.id = interaction.user.id;
      owner.interaction.channel.messages.fetch = async () => interaction.message;
      await handleConvertInteraction(owner.interaction);
      await work;
      assert.ok(isGif(firstReply(owner.calls).files[0].attachment));
    });

    test('generic MIME and an extensionless filename are classified by actual media streams', async () => {
      const attachment = {
        ...attachmentOf('flac'),
        contentType: 'application/octet-stream',
        name: 'track',
      };
      const { interaction, calls } = commandInteraction('cv-generic', {
        file: attachment,
        format: null,
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction), 'mp3');
      assert.ok(
        selected.menu.components[0].components[0].options.every(option =>
          ['mp3', 'm4a', 'ogg', 'wav', 'flac'].includes(option.value)
        )
      );
      assert.strictEqual(firstReply(selected.calls).files[0].name, 'track.mp3');
    });

    test('still-image pickers exclude video and audio outputs', async () => {
      const { interaction, calls } = commandInteraction('cv-image-picker', {
        file: attachmentOf('still'),
        format: null,
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction), 'webp');
      assert.deepStrictEqual(
        selected.menu.components[0].components[0].options.map(option => option.value).sort(),
        ['gif', 'jpg', 'png', 'webp']
      );
      assert.strictEqual(
        firstReply(selected.calls).files[0].attachment.subarray(8, 12).toString(),
        'WEBP'
      );
    });

    test('timestamps on a still image are curated before opening a picker', async () => {
      const { interaction, calls } = commandInteraction('cv-image-time', {
        file: attachmentOf('still'),
        format: null,
        start: '1',
      });
      await handleConvertCommand(interaction);
      assert.strictEqual(
        firstReply(calls).content,
        'start and end times do not apply to a still image.'
      );
    });

    test('GIF trim ranges preserve the requested animation and image outputs are labeled as still frames', async () => {
      const { interaction, calls } = commandInteraction('cv-anim-trim', {
        file: attachmentOf('anim'),
        format: null,
        start: '1',
        end: '3',
      });
      const selected = await chooseFrom(calls, handleConvertCommand(interaction));
      const png = selected.menu.components[0].components[0].options.find(
        option => option.value === 'png'
      );
      assert.match(png.description, /still frame/);
      const seconds = probeSeconds(firstReply(selected.calls).files[0].attachment, '.gif');
      assert.ok(seconds > 1.5 && seconds < 2.6);
    });

    test('explicit audio extraction from silent video is curated before encoding', async () => {
      const { interaction, calls } = commandInteraction('cv-silent', {
        file: attachmentOf('longvid'),
        format: 'mp3',
      });
      await handleConvertCommand(interaction);
      assert.strictEqual(firstReply(calls).content, 'that file has no audio to extract.');
    });

    test('invalid direct formats are refused instead of silently opening a picker', async () => {
      const { interaction, calls } = commandInteraction('cv-invalid-format', {
        file: attachmentOf('vid'),
        format: 'pdf',
      });
      await handleConvertCommand(interaction);
      assert.strictEqual(calls.reply[0].content, 'that output format is not supported.');
      assert.strictEqual(calls.deferReply.length, 0);
    });

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

    test('context menu finds a video embed without a text URL or attachment', async () => {
      const { interaction, calls } = contextInteraction('cv-embed', 'convert', []);
      interaction.targetMessage.embeds = [{ video: { url: 'https://example.com/vid-embed.mp4' } }];
      const selected = await chooseFrom(calls, handleConvertContextMenu(interaction));
      assert.ok(isGif(firstReply(selected.calls).files[0].attachment));
    });

    test('context menu converts an attachment in a forwarded message', async () => {
      const { interaction, calls } = contextInteraction('cv-forward', 'convert', []);
      interaction.targetMessage.messageSnapshots = new Map([
        ['source', { attachments: [attachmentOf('vid')], content: '' }],
      ]);
      const selected = await chooseFrom(calls, handleConvertContextMenu(interaction));
      assert.ok(isGif(firstReply(selected.calls).files[0].attachment));
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

    test('long video: converted, no length limit', async () => {
      const { interaction, calls } = commandInteraction(`cv-long-${Date.now()}`, {
        url: `https://example.com/longvid-${Date.now()}.mp4`,
      });
      await handleConvertCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test('format mp3: the audio track comes back as an mp3 attachment', async () => {
      const { interaction, calls } = commandInteraction(`cv-mp3-${Date.now()}`, {
        file: attachmentOf('vid'),
        format: 'mp3',
      });
      await handleConvertCommand(interaction);
      assert.ok(firstReply(calls).files[0].name.endsWith('.mp3'));
    });

    test('both a file and a url: the file is converted', async () => {
      const { interaction, calls } = commandInteraction(`cv-both-${Date.now()}`, {
        file: attachmentOf('vid'),
        url: 'https://example.com/vid.mp4',
      });
      await handleConvertCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test('url that is not media: refused, and the failure keeps the full link', async () => {
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
      assert.strictEqual(metadata.url, `https://example.com/page-${since}`);
      assert.ok(!('user_id' in alert) && !('operation_id' in alert));
    });

    test('context menu on a message with a video: converted to a gif', async () => {
      const { interaction, calls } = contextInteraction(`cv-ctx-${Date.now()}`, 'convert', [
        attachmentOf('vid'),
      ]);
      const selected = await chooseFrom(calls, handleConvertContextMenu(interaction));
      assert.ok(isGif(firstReply(selected.calls).files[0].attachment));
    });
  });

  describe('worker jobs', () => {
    const jobDirs = async () =>
      (await fs.readdir(JOBS_ROOT).catch(() => [])).filter(name => name.startsWith('job-'));

    for (const [kind, url] of [
      ['convert', 'https://example.com/vid-worker.mp4'],
      ['convert', 'https://example.com/page-worker'],
      ['optimize', 'https://example.com/anim-worker.gif'],
    ]) {
      test(`${kind} ${url.split('/').pop()}: leaves no file behind`, async () => {
        const before = await jobDirs();
        const { interaction } = commandInteraction(`job-${kind}-${Date.now()}`);
        await runMediaJob(interaction, { kind, args: { url, commandSource: 'slash' } });
        assert.deepStrictEqual(await jobDirs(), before);
      });
    }
  });

  describe('/optimize (full-pipeline E2E)', () => {
    test.skipIf(!hasGifsicle)('gif attachment: optimized gif attached', async () => {
      const { interaction, calls } = commandInteraction(`op-gif-${Date.now()}`, {
        file: attachmentOf('anim'),
      });
      await handleOptimizeCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test.skipIf(!hasGifsicle)('non-gif attachment: converted to an optimized gif', async () => {
      const { interaction, calls } = commandInteraction(`op-png-${Date.now()}`, {
        file: attachmentOf('still'),
      });
      await handleOptimizeCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test.skipIf(!hasGifsicle)('video attachment: converted to an optimized gif', async () => {
      const { interaction, calls } = commandInteraction('op-video', {
        file: attachmentOf('vid'),
      });
      await handleOptimizeCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
    });

    test.skipIf(!hasGifsicle)('file and URL: optimizes the attached gif', async () => {
      const { interaction, calls } = commandInteraction('op-both', {
        file: attachmentOf('anim'),
        url: 'https://example.com/page.html',
      });
      await handleOptimizeCommand(interaction);
      assert.ok(isGif(firstReply(calls).files[0].attachment));
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

    test('context menu finds an embedded gif without message text', async () => {
      const cache = new Map();
      const { interaction, calls } = contextInteraction('op-embed', 'optimize', []);
      const url = 'https://example.com/anim-embed.gif';
      interaction.targetMessage.embeds = [{ image: { url } }];
      await handleOptimizeContextMenuCommand(interaction, cache);
      assert.strictEqual(calls.showModal.length, 1);
      assert.strictEqual([...cache.values()][0].url, url);
    });
  });
}
