import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { pruneTimeSeriesRows } from '../../src/utils/database/retention-pg.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';
import { ensurePostgresInitialized } from '../../src/utils/database/init.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = days => Date.now() - days * DAY;

describe('retention', () => {
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

      await pruneTimeSeriesRows(daysAgo(30));

      const left = await sql`SELECT title FROM alerts WHERE component = ${tag}`;
      assert.deepStrictEqual(
        left.map(r => r.title),
        ['new'],
        'only the recent alert remains'
      );
    });
  });
});
