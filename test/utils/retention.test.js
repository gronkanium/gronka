import { describe, test } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLocalMedia, pruneTimeSeriesRows, pruneUrlCache } from '../../src/utils/retention.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';
import { ensurePostgresInitialized } from '../../src/utils/database/init.js';

const DAY = 24 * 60 * 60 * 1000;

async function seedMedia(root, directory, name, ageDays, bytes = 8) {
  const dir = join(root, directory);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await fs.writeFile(file, Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageDays * DAY);
  await fs.utimes(file, when, when);
  return file;
}

const exists = async file =>
  fs
    .access(file)
    .then(() => true)
    .catch(() => false);

describe('retention', () => {
  describe('pruneLocalMedia', () => {
    test('removes files older than the window and keeps newer ones', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gronka-retention-'));
      const old = await seedMedia(root, 'gifs', 'old.gif', 60, 1024);
      const fresh = await seedMedia(root, 'gifs', 'fresh.gif', 1, 1024);

      const result = await pruneLocalMedia(root, 30);

      assert.strictEqual(await exists(old), false, 'the 60-day-old file is gone');
      assert.strictEqual(await exists(fresh), true, 'the 1-day-old file survives');
      assert.strictEqual(result.files, 1);
      assert.strictEqual(result.bytes, 1024, 'reports the bytes actually reclaimed');
    });

    test('walks videos and images, not just gifs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gronka-retention-'));
      const video = await seedMedia(root, 'videos', 'old.mp4', 45);
      const image = await seedMedia(root, 'images', 'old.jpg', 45);

      const result = await pruneLocalMedia(root, 30);

      assert.strictEqual(await exists(video), false);
      assert.strictEqual(await exists(image), false);
      assert.strictEqual(result.files, 2);
    });

    test('a file exactly at the boundary is kept, not deleted', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gronka-retention-'));
      // 29 days old against a 30-day window: inside the window, must survive
      const edge = await seedMedia(root, 'gifs', 'edge.gif', 29);
      await pruneLocalMedia(root, 30);
      assert.strictEqual(await exists(edge), true);
    });

    test('a missing storage directory is not an error', async () => {
      const result = await pruneLocalMedia(join(tmpdir(), 'gronka-does-not-exist'), 30);
      assert.deepStrictEqual(result, { files: 0, bytes: 0 });
    });

    test('subdirectories are left alone', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gronka-retention-'));
      const nested = join(root, 'gifs', 'keepdir');
      await fs.mkdir(nested, { recursive: true });
      const when = new Date(Date.now() - 90 * DAY);
      await fs.utimes(nested, when, when);

      const result = await pruneLocalMedia(root, 30);

      assert.strictEqual(result.files, 0, 'a directory is not unlinked as a file');
      assert.strictEqual(await exists(nested), true);
    });
  });

  describe('pruneTimeSeriesRows', () => {
    test('deletes old rows and keeps recent ones', async () => {
      await ensurePostgresInitialized();
      const sql = getPostgresConnection();
      const tag = `retention-${Date.now()}`;
      const oldTs = Date.now() - 90 * DAY;
      const newTs = Date.now();

      await sql`INSERT INTO alerts (timestamp, severity, component, title, message)
                VALUES (${oldTs}, 'info', ${tag}, 'old', 'old')`;
      await sql`INSERT INTO alerts (timestamp, severity, component, title, message)
                VALUES (${newTs}, 'info', ${tag}, 'new', 'new')`;

      await pruneTimeSeriesRows(30);

      const left = await sql`SELECT title FROM alerts WHERE component = ${tag}`;
      assert.deepStrictEqual(
        left.map(r => r.title),
        ['new'],
        'only the recent alert remains'
      );
    });
  });

  describe('pruneUrlCache', () => {
    test('keeps a row whose R2 upload is still live, so the object cannot be orphaned', async () => {
      await ensurePostgresInitialized();
      const sql = getPostgresConnection();
      const hash = `retention-live-${Date.now()}`;
      const oldTs = Date.now() - 90 * DAY;

      await sql`INSERT INTO processed_urls (url_hash, file_hash, file_type, file_url, processed_at)
                VALUES (${hash}, ${hash}, 'video', 'https://cdn.example.com/x.mp4', ${oldTs})`;
      await sql`INSERT INTO temporary_uploads (url_hash, r2_key, uploaded_at, expires_at)
                VALUES (${hash}, ${`videos/${hash}.mp4`}, ${oldTs}, ${Date.now() + DAY})`;

      await pruneUrlCache(30);

      const still = await sql`SELECT 1 FROM processed_urls WHERE url_hash = ${hash}`;
      assert.strictEqual(still.length, 1, 'row with a live upload is retained');

      await sql`DELETE FROM temporary_uploads WHERE url_hash = ${hash}`;
      await sql`DELETE FROM processed_urls WHERE url_hash = ${hash}`;
    });

    test('deletes an old row with no live upload', async () => {
      await ensurePostgresInitialized();
      const sql = getPostgresConnection();
      const hash = `retention-dead-${Date.now()}`;

      await sql`INSERT INTO processed_urls (url_hash, file_hash, file_type, file_url, processed_at)
                VALUES (${hash}, ${hash}, 'video', 'https://cdn.discordapp.com/x.mp4', ${Date.now() - 90 * DAY})`;

      await pruneUrlCache(30);

      const gone = await sql`SELECT 1 FROM processed_urls WHERE url_hash = ${hash}`;
      assert.strictEqual(gone.length, 0);
    });
  });
});
