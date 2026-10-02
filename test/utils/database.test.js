import { test, describe, beforeAll } from 'bun:test';
import assert from 'node:assert';
import {
  initDatabase,
  countCommand,
  getCommandTotals,
  getHourlyCounts,
} from '../../src/utils/database.js';

beforeAll(async () => {
  await initDatabase();
});

describe('database utilities', () => {
  test('initDatabase can be called more than once', async () => {
    await initDatabase();
    await initDatabase();
  });

  describe('command counts', () => {
    test('concurrent counts for the same hour all land on one row', async () => {
      const command = `count-${Date.now()}`;
      await Promise.all(Array.from({ length: 20 }, () => countCommand(command, 'success')));
      const rows = (await getCommandTotals()).filter(r => r.command === command);
      assert.deepStrictEqual(rows, [{ command, outcome: 'success', count: 20 }]);
    });

    test('totals respect the since cutoff', async () => {
      const command = `old-${Date.now()}`;
      await countCommand(command, 'error', Date.now() - 3 * 24 * 3600e3);
      const recent = (await getCommandTotals(Date.now() - 24 * 3600e3)).filter(
        r => r.command === command
      );
      assert.strictEqual(recent.length, 0);
      const all = (await getCommandTotals()).filter(r => r.command === command);
      assert.strictEqual(all[0].count, 1);
    });

    test('hourly counts are zero-filled, oldest first, split by outcome', async () => {
      const before = (await getHourlyCounts(24)).at(-1);
      await countCommand(`hourly-${Date.now()}`, 'error');
      const series = await getHourlyCounts(24);
      assert.strictEqual(series.length, 24);
      assert.ok(Date.parse(series[0].hour) < Date.parse(series[23].hour));
      assert.strictEqual(series.at(-1).error, before.error + 1);
      assert.strictEqual(series.at(-1).count, before.count + 1);
    });
  });
});
