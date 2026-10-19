import { test, describe, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFakeInteraction } from '../helpers/fake-interaction.js';

// No module mocks: a fake cobalt answers over real HTTP with files ffmpeg made, and everything
// from intake to the Discord reply is the real code. Only Discord and the upstream site are fake.
const e2e = process.env.GRONKA_E2E === 'true';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
const asked = [];
let cobalt;
let handleDownloadCommand;
let getAlerts;
let jobsRoot;

function ffmpeg(args, out) {
  const run = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', ...args, out]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return fs.readFileSync(out);
}

function probe(bytes, ext) {
  const file = path.join(os.tmpdir(), `gronka-pipeline-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(file, bytes);
  const run = Bun.spawnSync([
    ...['ffprobe', '-v', 'error', '-select_streams', 'v:0'],
    ...['-show_entries', 'stream=codec_name,width,height', '-of', 'json', file],
  ]);
  fs.rmSync(file, { force: true });
  return JSON.parse(run.stdout.toString()).streams[0];
}

// What cobalt answers for each post, keyed by the status id in the link.
const answers = {
  video: () => ({ status: 'tunnel', url: 'http://cobalt:9000/tunnel?id=video', filename: 'x.mp4' }),
  photos: port => ({
    status: 'picker',
    picker: [
      { type: 'photo', url: `http://127.0.0.1:${port}/media/one.png` },
      { type: 'photo', url: `http://127.0.0.1:${port}/media/two.jpg` },
    ],
  }),
  gone: () => ({ status: 'error', error: { code: 'error.api.content.post.unavailable' } }),
  empty: () => ({ status: 'tunnel', url: 'http://cobalt:9000/tunnel?id=empty', filename: 'x.mp4' }),
};

function startCobalt() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      if (request.method === 'POST' && pathname === '/') {
        const { url } = await request.json();
        asked.push(url);
        const post = url.match(/status\/(\w+)/)?.[1];
        return Response.json((answers[post] ?? answers.gone)(cobalt.port));
      }
      if (pathname === '/tunnel') {
        if (searchParams.get('id') === 'empty') return new Response('', { status: 200 });
        return new Response(files.mp4, { headers: { 'content-type': 'video/mp4' } });
      }
      if (pathname === '/media/one.png') {
        return new Response(files.png, { headers: { 'content-type': 'image/png' } });
      }
      if (pathname === '/media/two.jpg') {
        // a CDN that labels everything octet-stream; the bytes decide the type
        return new Response(files.jpg, { headers: { 'content-type': 'application/octet-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

function download(url) {
  const { interaction, calls } = createFakeInteraction({ deferred: false });
  interaction.options = {
    getString: name => (name === 'url' ? url : null),
    getBoolean: () => null,
    getNumber: () => null,
  };
  return { interaction, calls };
}

const jobDirs = () => (fs.existsSync(jobsRoot) ? fs.readdirSync(jobsRoot) : []);

if (!e2e) {
  test.skip('the real download pipeline runs in bun run test:e2e', () => {});
} else {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronka-pipeline-'));
    files.mp4 = ffmpeg(
      ['-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10:duration=2', '-pix_fmt', 'yuv420p'],
      `${dir}/clip.mp4`
    );
    files.png = ffmpeg(
      ['-f', 'lavfi', '-i', 'testsrc=size=40x30', '-frames:v', '1'],
      `${dir}/a.png`
    );
    files.jpg = ffmpeg(
      ['-f', 'lavfi', '-i', 'testsrc=size=50x20', '-frames:v', '1'],
      `${dir}/b.jpg`
    );
    fs.rmSync(dir, { recursive: true, force: true });

    cobalt = startCobalt();
    process.env.COBALT_API_URL = `http://127.0.0.1:${cobalt.port}`;
    process.env.COBALT_ENABLED = 'true';
    ({ JOBS_ROOT: jobsRoot } = await import('../../src/utils/media-file.js'));
    ({ handleDownloadCommand } = await import('../../src/commands/download.js'));
    ({ getAlerts } = await import('../../src/utils/database.js'));
  });

  afterAll(() => cobalt?.stop(true));

  const alertFor = async (url, since) =>
    (await getAlerts({ command: 'download', startTime: since, limit: 50 }))
      .map(row => JSON.parse(row.metadata))
      .find(metadata => metadata.url === url);

  describe('download pipeline over real HTTP', () => {
    test('an X video arrives byte for byte as a playable mp4 attachment', async () => {
      const url = 'https://x.com/someone/status/video';
      const before = jobDirs();
      const { interaction, calls } = download(url);

      await handleDownloadCommand(interaction);

      expect(asked).toContain(url);
      const [file, ...rest] = calls.editReply.at(-1).files;
      expect(rest).toEqual([]);
      expect(file.name).toEndWith('.mp4');
      expect(sha(file.attachment)).toBe(sha(files.mp4));
      expect(probe(file.attachment, '.mp4')).toEqual({ codec_name: 'h264', width: 96, height: 64 });
      expect(jobDirs()).toEqual(before);
    });

    test('a photo post sends every photo with the type its bytes say', async () => {
      const { interaction, calls } = download('https://x.com/someone/status/photos');

      await handleDownloadCommand(interaction);

      const sent = calls.editReply.at(-1).files;
      expect(sent.map(f => path.extname(f.name))).toEqual(['.png', '.jpg']);
      expect(sent.map(f => sha(f.attachment))).toEqual([sha(files.png), sha(files.jpg)]);
    });

    test('a deleted post gets the curated message and a failure record with its cause', async () => {
      const url = 'https://x.com/someone/status/gone';
      const since = Date.now();
      const { interaction, calls } = download(url);

      await handleDownloadCommand(interaction);

      const reply = calls.editReply.at(-1);
      expect(reply.files).toBeUndefined();
      expect(reply.content).toBe('this post is unavailable, it may be deleted or private');
      const alert = await alertFor(url, since);
      expect(alert.cause).toContain('error.api.content.post.unavailable');
      const steps = alert.trail.map(step => step.step);
      expect(steps).not.toContain('yt-dlp');
      expect(steps).not.toContain('cobalt direct url');
    });

    test('a link to a private address is refused before cobalt is asked', async () => {
      const url = `http://127.0.0.1:${cobalt.port}/media/one.png`;
      const { interaction, calls } = download(url);

      await handleDownloadCommand(interaction);

      expect(asked).not.toContain(url);
      expect(calls.editReply.at(-1)?.files ?? calls.reply.at(-1)?.files).toBeUndefined();
    });
  });
}
