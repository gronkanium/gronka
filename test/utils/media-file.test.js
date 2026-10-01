import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'bun:test';
import {
  fromPath,
  tempPath,
  withExtension,
  withJobDir,
  writeAtomic,
  writeStream,
} from '../../src/utils/media-file.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

describe('media-file', () => {
  test('writeStream lands the bytes on disk with their hash, size and head', async () => {
    const chunks = [Buffer.from('GIF89a'), Buffer.alloc(100_000, 7)];
    const file = await writeStream(Readable.from(chunks), { ext: '.gif' });
    const bytes = await fs.readFile(file.path);
    assert.equal(file.size, bytes.length);
    assert.equal(file.hash, sha(bytes));
    assert.equal(file.head.subarray(0, 6).toString(), 'GIF89a');
    assert.equal(file.head.length, 64);
    assert.ok(file.path.endsWith('.gif'));
  });

  test('writeStream stops at maxSize and leaves no partial file', async () => {
    const dir = await withJobDir(async () => {
      await assert.rejects(
        writeStream(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), { maxSize: 15 }),
        error => error.code === 'TOO_LARGE'
      );
      return (await tempPath()).replace(/\/[^/]+$/, '');
    });
    await assert.rejects(fs.access(dir));
  });

  test('withJobDir removes every file made inside it, even on a throw', async () => {
    let made;
    await assert.rejects(
      withJobDir(async () => {
        made = await tempPath('.mp4');
        await fs.writeFile(made, 'x');
        throw new Error('boom');
      }),
      /boom/
    );
    await assert.rejects(fs.access(made));
  });

  test('nested withJobDir shares the outer dir', async () => {
    await withJobDir(async () => {
      const outer = await tempPath();
      const inner = await withJobDir(() => tempPath());
      assert.equal(outer.replace(/[^/]+$/, ''), inner.replace(/[^/]+$/, ''));
    });
  });

  test('fromPath matches what writeStream reports', async () => {
    const written = await writeStream(Readable.from([Buffer.from('hello world')]));
    const read = await fromPath(written.path, { filename: 'a.txt' });
    assert.equal(read.hash, written.hash);
    assert.equal(read.size, 11);
    assert.equal(read.filename, 'a.txt');
  });

  test('withExtension renames the file to its filename extension', async () => {
    const file = await writeStream(Readable.from([Buffer.from('x')]));
    const named = await withExtension({ ...file, filename: 'clip.MP4' });
    assert.ok(named.path.endsWith('.mp4'));
    await fs.access(named.path);
  });
});

describe('writeAtomic', () => {
  test('a failed write leaves neither the final file nor its part file', () =>
    withJobDir(async () => {
      const dir = await tempPath();
      await fs.mkdir(dir);
      const final = `${dir}/a.gif`;
      await assert.rejects(
        writeAtomic(final, async part => {
          await fs.writeFile(part, 'half');
          throw new Error('killed');
        })
      );
      assert.deepEqual(await fs.readdir(dir), []);
      await writeAtomic(final, part => fs.writeFile(part, 'whole'));
      assert.deepEqual(await fs.readdir(dir), ['a.gif']);
      assert.equal(await fs.readFile(final, 'utf8'), 'whole');
    }));
});

describe('job cancellation', () => {
  test('cancelling a job aborts its http requests and child processes', async () => {
    const { default: axios } = await import('axios');
    const { runFfmpeg } = await import('../../src/utils/video-processor/utils.js');
    const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
    const cancel = new AbortController();
    try {
      const started = Date.now();
      const results = withJobDir(
        () =>
          Promise.allSettled([
            axios.get(`http://127.0.0.1:${server.port}/`),
            runFfmpeg(['-re', '-f', 'lavfi', '-i', 'anullsrc', '-t', '60', '-f', 'null', '-']),
          ]),
        { signal: cancel.signal }
      );
      setTimeout(() => cancel.abort(), 200);
      const [http, ffmpeg] = await results;
      expect(http.status).toBe('rejected');
      expect(ffmpeg.status).toBe('rejected');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });
});
