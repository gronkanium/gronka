import { test, expect, describe, beforeAll } from 'bun:test';
import {
  trackRequest,
  succeed,
  failed,
  requestOutcome,
  flushCounts,
} from '../../src/utils/operations-tracker.js';
import { initDatabase, getCommandTotals } from '../../src/utils/database.js';

const total = async (command, outcome) =>
  (await getCommandTotals()).find(r => r.command === command && r.outcome === outcome)?.count ?? 0;

describe('request outcome', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  test('each request adds exactly one anonymous count for how it ended', async () => {
    const command = `t${Date.now()}`;
    await trackRequest(command, async () => succeed());
    await trackRequest(command, async () => failed());
    await trackRequest(command, async () => {});
    await trackRequest(command, async () => {
      throw new Error('boom');
    }).catch(() => {});
    await flushCounts();
    expect(await total(command, 'success')).toBe(1);
    expect(await total(command, 'error')).toBe(3);
  });

  test('a failure after success inside one request still counts once, as an error', async () => {
    const command = `t2${Date.now()}`;
    await trackRequest(command, async () => {
      succeed();
      failed();
      expect(requestOutcome()).toBe('error');
    });
    await flushCounts();
    expect(await total(command, 'error')).toBe(1);
    expect(await total(command, 'success')).toBe(0);
  });

  test('outside a request there is nothing to mark', () => {
    expect(failed()).toBe(false);
    expect(requestOutcome()).toBeNull();
  });
});
