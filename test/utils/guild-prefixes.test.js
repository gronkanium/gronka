import { test, describe, beforeAll } from 'bun:test';
import assert from 'node:assert';
import {
  initDatabase,
  getGuildPrefix,
  setGuildPrefix,
  clearGuildPrefix,
} from '../../src/utils/database.js';
import { invalidateGuildPrefixCache } from '../../src/utils/database/guild-prefixes-pg.js';

beforeAll(async () => {
  await initDatabase();
});

// The test DB persists between runs, so every test uses a unique guild id
const uniqueGuildId = () => `prefix-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('guild prefixes', () => {
  test('returns null for a guild without a custom prefix', async () => {
    assert.strictEqual(await getGuildPrefix(uniqueGuildId()), null);
  });

  test('set + get roundtrip', async () => {
    const guildId = uniqueGuildId();
    await setGuildPrefix(guildId, '!');
    assert.strictEqual(await getGuildPrefix(guildId), '!');
  });

  test('setting again overwrites the previous prefix', async () => {
    const guildId = uniqueGuildId();
    await setGuildPrefix(guildId, '!');
    await setGuildPrefix(guildId, '?');
    assert.strictEqual(await getGuildPrefix(guildId), '?');
  });

  test('clear removes the override', async () => {
    const guildId = uniqueGuildId();
    await setGuildPrefix(guildId, '!');
    await clearGuildPrefix(guildId);
    assert.strictEqual(await getGuildPrefix(guildId), null);
  });

  test('writes invalidate the cache so reads see fresh values immediately', async () => {
    const guildId = uniqueGuildId();

    // Prime the cache with the "no prefix" result, then write - the cached null
    // must not be served afterwards
    assert.strictEqual(await getGuildPrefix(guildId), null);
    await setGuildPrefix(guildId, '$');
    assert.strictEqual(await getGuildPrefix(guildId), '$');

    invalidateGuildPrefixCache();
    assert.strictEqual(await getGuildPrefix(guildId), '$');
  });
});
