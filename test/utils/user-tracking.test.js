import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  trackUser,
  getUniqueUserCount,
  initializeUserTracking,
  trackRecentConversion,
  getRecentConversions,
} from '../../src/utils/user-tracking.js';
import { initDatabase, closeDatabase, getUser } from '../../src/utils/database.js';
import { invalidateUserCache } from '../../src/utils/database/users-pg.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbDir = path.join(os.tmpdir(), 'gronka-test-db');
const tempDbPath = path.join(tempDbDir, 'user-tracking-test.db');

// Set environment variable to use temp database for tests
process.env.GRONKA_DB_PATH = tempDbPath;

before(async () => {
  // Create temp directory for test database
  fs.mkdirSync(tempDbDir, { recursive: true });
  // Remove test database if it exists
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }
  // Clear user cache to avoid stale data from previous test runs
  invalidateUserCache();
  await initDatabase();
  await initializeUserTracking();
});

after(() => {
  closeDatabase();
  // Clean up test database
  if (fs.existsSync(tempDbPath)) {
    try {
      fs.unlinkSync(tempDbPath);
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe('user tracking utilities', () => {
  describe('trackUser', () => {
    test('tracks new user with username', async () => {
      const uniqueId = Date.now();
      const userId = `test-track-1-${uniqueId}`;
      const username = 'TestUser1';
      const beforeTimestamp = Date.now();

      await trackUser(userId, username);

      const user = await getUser(userId);
      assert.ok(user, 'User should be tracked');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username);
      assert.ok(user.first_used > 0);
      assert.ok(user.last_used > 0);
      // trackUser generates its own timestamp, so check it's within reasonable range
      const afterTimestamp = Date.now();
      assert.ok(
        user.first_used >= beforeTimestamp && user.first_used <= afterTimestamp,
        `first_used should be between ${beforeTimestamp} and ${afterTimestamp}, got ${user.first_used}`
      );
      assert.ok(
        user.last_used >= beforeTimestamp && user.last_used <= afterTimestamp,
        `last_used should be between ${beforeTimestamp} and ${afterTimestamp}, got ${user.last_used}`
      );
      // For new users, first_used and last_used should be the same (within 100ms tolerance)
      assert.ok(
        Math.abs(user.first_used - user.last_used) < 100,
        `first_used and last_used should be approximately equal for new user`
      );
    });

    test('tracks user without username (uses default)', async () => {
      const userId = 'test-track-2';

      await trackUser(userId);

      const user = await getUser(userId);
      assert.ok(user, 'User should be tracked');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, 'unknown');
    });

    test('updates existing user last_used', async () => {
      const userId = 'test-track-3';
      const username = 'TestUser3';

      await trackUser(userId, username);
      const user1 = await getUser(userId);
      const firstUsed = user1.first_used;
      const lastUsed1 = user1.last_used;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await trackUser(userId, username);
      const user2 = await getUser(userId);

      assert.strictEqual(user2.first_used, firstUsed, 'first_used should not change');
      assert.ok(user2.last_used > lastUsed1, 'last_used should be updated');
    });

    test('updates username if changed', async () => {
      const userId = 'test-track-4';
      const username1 = 'TestUser4a';
      const username2 = 'TestUser4b';

      await trackUser(userId, username1);
      const user1 = await getUser(userId);
      assert.strictEqual(user1.username, username1);

      await trackUser(userId, username2);
      const user2 = await getUser(userId);
      assert.strictEqual(user2.username, username2);
    });

    test('handles invalid userId gracefully', async () => {
      await assert.doesNotReject(async () => {
        await trackUser(null);
        await trackUser('');
        await trackUser(123);
      });
    });
  });

  describe('getUniqueUserCount', () => {
    test('returns correct count', async () => {
      const countBefore = await getUniqueUserCount();
      const uniqueId = Date.now();

      await trackUser(`test-count-1-${uniqueId}`, 'User1');
      await trackUser(`test-count-2-${uniqueId}`, 'User2');
      await trackUser(`test-count-3-${uniqueId}`, 'User3');

      const countAfter = await getUniqueUserCount();
      assert.strictEqual(countAfter, countBefore + 3);
    });

    test('does not increase count for existing users', async () => {
      const uniqueId = Date.now();
      const userId = `test-count-existing-${uniqueId}`;
      const countBefore = await getUniqueUserCount();

      await trackUser(userId, 'User');
      const countAfter1 = await getUniqueUserCount();
      assert.strictEqual(countAfter1, countBefore + 1);

      await trackUser(userId, 'User');
      const countAfter2 = await getUniqueUserCount();
      assert.strictEqual(
        countAfter2,
        countBefore + 1,
        'Count should not increase for existing user'
      );
    });
  });

  describe('initializeUserTracking', () => {
    test('can be called multiple times safely', async () => {
      await initializeUserTracking();
      await initializeUserTracking();
      assert.ok(true, 'Multiple calls handled');
    });
  });

  describe('trackRecentConversion', () => {
    test('tracks recent conversion', () => {
      const userId = 'test-recent-1';
      const url = 'https://example.com/gif.gif';

      trackRecentConversion(userId, url);

      const conversions = getRecentConversions(userId);
      assert.ok(conversions.length > 0);
      assert.strictEqual(conversions[0], url);
    });

    test('keeps only last 10 conversions', () => {
      const userId = 'test-recent-2';

      // Add 12 conversions
      for (let i = 0; i < 12; i++) {
        trackRecentConversion(userId, `https://example.com/gif${i}.gif`);
      }

      const conversions = getRecentConversions(userId);
      assert.strictEqual(conversions.length, 10);
      assert.strictEqual(conversions[0], 'https://example.com/gif11.gif');
      assert.strictEqual(conversions[9], 'https://example.com/gif2.gif');
    });

    test('moves existing conversion to front', () => {
      const userId = 'test-recent-3';
      const url1 = 'https://example.com/gif1.gif';
      const url2 = 'https://example.com/gif2.gif';
      const url3 = 'https://example.com/gif3.gif';

      trackRecentConversion(userId, url1);
      trackRecentConversion(userId, url2);
      trackRecentConversion(userId, url3);

      let conversions = getRecentConversions(userId);
      assert.strictEqual(conversions[0], url3);

      // Add url1 again - it should move to front
      trackRecentConversion(userId, url1);
      conversions = getRecentConversions(userId);
      assert.strictEqual(conversions[0], url1);
      assert.strictEqual(conversions.length, 3);
    });

    test('returns empty array for non-existent user', () => {
      const conversions = getRecentConversions('non-existent-user');
      assert.deepStrictEqual(conversions, []);
    });

    test('handles invalid input gracefully', () => {
      assert.doesNotThrow(() => {
        trackRecentConversion(null, 'url');
        trackRecentConversion('user', null);
        trackRecentConversion('', 'url');
        trackRecentConversion('user', '');
      });

      assert.deepStrictEqual(getRecentConversions(null), []);
      assert.deepStrictEqual(getRecentConversions(''), []);
    });
  });
});
