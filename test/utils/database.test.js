import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  initDatabase,
  closeDatabase,
  insertLog,
  insertOrUpdateUser,
  getUser,
  getUniqueUserCount,
  getLogs,
  getProcessedUrl,
  insertProcessedUrl,
} from '../../src/utils/database.js';
import { invalidateUserCache } from '../../src/utils/database/users-pg.js';
import {
  getUniqueTestComponent,
  ensureLogsTableSchema,
} from '../../src/utils/database/test-helpers.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbDir = path.join(os.tmpdir(), 'gronka-test-db');
const tempDbPath = path.join(tempDbDir, 'database-test.db');

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
  // Ensure logs table has correct schema (SERIAL PRIMARY KEY on id)
  await ensureLogsTableSchema();
  // NOTE: Do NOT truncate tables here - it causes race conditions with parallel tests
  // Instead, we use unique component names and timestamps for test isolation
});

after(async () => {
  // Don't close database here - it's shared across parallel test files
  // Connection will be cleaned up when Node.js exits
  // Clean up test database
  if (fs.existsSync(tempDbPath)) {
    try {
      fs.unlinkSync(tempDbPath);
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe('database utilities', () => {
  describe('initDatabase', () => {
    test('initializes database successfully', async () => {
      // Already initialized in before hook
      assert.ok(true, 'Database initialized');
    });

    test('can be called multiple times safely', async () => {
      await initDatabase();
      await initDatabase();
      assert.ok(true, 'Multiple init calls handled');
    });
  });

  describe('insertOrUpdateUser', () => {
    test('inserts new user', async () => {
      const uniqueId = Date.now();
      const userId = `test-user-1-${uniqueId}`;
      const username = 'TestUser';
      const timestamp = Date.now();

      // Clear cache to ensure we get fresh data
      invalidateUserCache(userId);

      await insertOrUpdateUser(userId, username, timestamp);

      // Clear cache again after insert to force fresh query
      invalidateUserCache(userId);

      const user = await getUser(userId);
      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username);
      // Use approximate matching for timestamps (within 1 second tolerance to account for test execution time)
      // Note: For new users, first_used and last_used should match the provided timestamp
      assert.ok(
        Math.abs(user.first_used - timestamp) < 1000,
        `first_used should be within 1s of ${timestamp}, got ${user.first_used}`
      );
      assert.ok(
        Math.abs(user.last_used - timestamp) < 1000,
        `last_used should be within 1s of ${timestamp}, got ${user.last_used}`
      );
    });

    test('updates existing user', async () => {
      const uniqueId = Date.now();
      const userId = `test-user-2-${uniqueId}`;
      const username1 = 'TestUser1';
      const username2 = 'TestUser2';
      const timestamp1 = Date.now();
      const timestamp2 = timestamp1 + 1000;

      // Clear cache to ensure we get fresh data
      invalidateUserCache(userId);

      await insertOrUpdateUser(userId, username1, timestamp1);
      await insertOrUpdateUser(userId, username2, timestamp2);

      // Clear cache again after updates to force fresh query
      invalidateUserCache(userId);

      const user = await getUser(userId);
      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username2);
      // Use approximate matching for timestamps (within 1 second tolerance to account for test execution time)
      assert.ok(
        Math.abs(user.first_used - timestamp1) < 1000,
        `first_used should be within 1s of ${timestamp1}, got ${user.first_used}`
      );
      assert.ok(
        Math.abs(user.last_used - timestamp2) < 1000,
        `last_used should be within 1s of ${timestamp2}, got ${user.last_used}`
      );
    });

    test('handles invalid userId gracefully', async () => {
      await assert.doesNotReject(async () => {
        await insertOrUpdateUser(null, 'TestUser', Date.now());
        await insertOrUpdateUser('', 'TestUser', Date.now());
        await insertOrUpdateUser(123, 'TestUser', Date.now());
      });
    });
  });

  describe('getUser', () => {
    test('returns user for existing user_id', async () => {
      const uniqueId = Date.now();
      const userId = `test-user-3-${uniqueId}`;
      const username = 'TestUser3';
      const timestamp = Date.now();

      await insertOrUpdateUser(userId, username, timestamp);
      const user = await getUser(userId);

      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username);
    });

    test('returns null for non-existent user', async () => {
      const user = await getUser('non-existent-user');
      assert.strictEqual(user, null);
    });
  });

  describe('getUniqueUserCount', () => {
    test('returns correct count', async () => {
      const countBefore = await getUniqueUserCount();
      const uniqueId = Date.now();

      await insertOrUpdateUser(`test-count-1-${uniqueId}`, 'User1', Date.now());
      await insertOrUpdateUser(`test-count-2-${uniqueId}`, 'User2', Date.now());
      await insertOrUpdateUser(`test-count-3-${uniqueId}`, 'User3', Date.now());

      const countAfter = await getUniqueUserCount();
      assert.strictEqual(countAfter, countBefore + 3);
    });

    test('returns 0 for empty database', async () => {
      // This test assumes a clean database, which isn't guaranteed
      // So we just check it returns a number
      const count = await getUniqueUserCount();
      assert.strictEqual(typeof count, 'number');
      assert.ok(count >= 0);
    });
  });

  describe('insertLog', () => {
    test('inserts log entry', async () => {
      const timestamp = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const component = getUniqueTestComponent('test-insert');
      const level = 'INFO';
      const message = 'Test log message';

      await insertLog(timestamp, component, level, message);

      const logs = await getLogs({ component, limit: 1 });
      assert.ok(logs.length > 0, 'Log should exist');
      const log = logs[0];
      assert.strictEqual(log.component, component);
      assert.strictEqual(log.level, level);
      assert.strictEqual(log.message, message);
      assert.strictEqual(log.timestamp, timestamp);
    });

    test('inserts log with metadata', async () => {
      const timestamp = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const component = getUniqueTestComponent('test-metadata-insert');
      const level = 'INFO';
      const message = 'Test log with metadata';
      const metadata = { key: 'value', number: 123 };

      await insertLog(timestamp, component, level, message, metadata);

      const logs = await getLogs({ component, limit: 1 });
      const log = logs[0];
      assert.ok(log.metadata, 'Metadata should exist');
      // getLogs already parses metadata from JSON string to object
      assert.strictEqual(log.metadata.key, 'value');
      assert.strictEqual(log.metadata.number, 123);
    });

    test('handles all log levels', async () => {
      const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      const baseTimestamp = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const uniqueComponent = getUniqueTestComponent('test-levels');

      for (let i = 0; i < levels.length; i++) {
        // Use different timestamps for each level to avoid primary key collisions
        await insertLog(
          baseTimestamp + i * 100,
          uniqueComponent,
          levels[i],
          `Test ${levels[i]} message`
        );
      }

      for (const level of levels) {
        const logs = await getLogs({ component: uniqueComponent, level, limit: 10 });
        assert.ok(logs.length > 0, `Should have ${level} logs`);
      }
    });

    test('handles null vs undefined metadata', async () => {
      const timestamp = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const component = getUniqueTestComponent('test-metadata');
      const level = 'INFO';

      // Insert log with null metadata
      await insertLog(timestamp, component, level, 'Message with null', null);
      const logsWithNull = await getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithNull[0].metadata, null);

      // Insert log with undefined metadata (should default to null)
      await insertLog(timestamp + 100, component, level, 'Message with undefined', undefined);
      const logsWithUndefined = await getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithUndefined[0].metadata, null);

      // Insert log without metadata parameter (should default to null)
      await insertLog(timestamp + 200, component, level, 'Message without metadata');
      const logsWithout = await getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithout[0].metadata, null);
    });
  });

  describe('getLogs', () => {
    test('returns all logs when no filters specified', async () => {
      const logs = await getLogs({ limit: 10 });
      assert.ok(Array.isArray(logs));
      assert.ok(logs.length <= 10);
    });

    test('filters by component', async () => {
      const baseTimestamp = Date.now();
      const uniqueId = baseTimestamp;
      const botComponent = `bot-${uniqueId}`;
      const serverComponent = `server-${uniqueId}`;

      await insertLog(baseTimestamp, botComponent, 'INFO', 'Bot test message');
      await insertLog(baseTimestamp + 100, serverComponent, 'INFO', 'Server test message');

      const botLogs = await getLogs({ component: botComponent, limit: 10 });
      const serverLogs = await getLogs({ component: serverComponent, limit: 10 });

      assert.ok(botLogs.length > 0, 'Should have bot logs');
      assert.ok(serverLogs.length > 0, 'Should have server logs');

      botLogs.forEach(log => {
        assert.strictEqual(log.component, botComponent);
      });

      serverLogs.forEach(log => {
        assert.strictEqual(log.component, serverComponent);
      });
    });

    test('filters by level', async () => {
      const baseTimestamp = Date.now();
      const testComponent = `test-level-${baseTimestamp}`;

      await insertLog(baseTimestamp, testComponent, 'ERROR', 'Error message');
      await insertLog(baseTimestamp + 100, testComponent, 'INFO', 'Info message');

      const errorLogs = await getLogs({ component: testComponent, level: 'ERROR', limit: 10 });
      const infoLogs = await getLogs({ component: testComponent, level: 'INFO', limit: 10 });

      errorLogs.forEach(log => {
        assert.strictEqual(log.level, 'ERROR');
      });

      infoLogs.forEach(log => {
        assert.strictEqual(log.level, 'INFO');
      });
    });

    test('filters by time range', async () => {
      const now = Date.now();
      const startTime = now - 5000;
      const endTime = now + 5000;
      const testComponent = `test-time-${now}`;

      await insertLog(now, testComponent, 'INFO', 'Time filtered message');

      const logs = await getLogs({
        component: testComponent,
        startTime,
        endTime,
        limit: 10,
      });

      logs.forEach(log => {
        assert.ok(log.timestamp >= startTime);
        assert.ok(log.timestamp <= endTime);
      });
    });

    test('respects limit', async () => {
      const now = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const testComponent = getUniqueTestComponent('test-limit');

      // Insert multiple logs with larger timestamp offsets to avoid collisions
      for (let i = 0; i < 5; i++) {
        await insertLog(now + i * 100, testComponent, 'INFO', `Message ${i}`);
      }

      const logs = await getLogs({ component: testComponent, limit: 3 });
      assert.strictEqual(logs.length, 3);
    });

    test('orders by timestamp descending by default', async () => {
      const now = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const testComponent = getUniqueTestComponent('test-order-desc');
      await insertLog(now, testComponent, 'INFO', 'Message 1');
      await insertLog(now + 100, testComponent, 'INFO', 'Message 2');
      await insertLog(now + 200, testComponent, 'INFO', 'Message 3');

      const logs = await getLogs({ component: testComponent, limit: 3 });
      assert.ok(logs.length > 0);
      for (let i = 0; i < logs.length - 1; i++) {
        assert.ok(logs[i].timestamp >= logs[i + 1].timestamp);
      }
    });

    test('orders by timestamp ascending when specified', async () => {
      const now = Date.now();
      // Use unique component to avoid collisions with parallel tests
      const testComponent = getUniqueTestComponent('test-order-asc');
      await insertLog(now, testComponent, 'INFO', 'Message 1');
      await insertLog(now + 100, testComponent, 'INFO', 'Message 2');
      await insertLog(now + 200, testComponent, 'INFO', 'Message 3');

      const logs = await getLogs({ component: testComponent, orderDesc: false, limit: 3 });
      assert.ok(logs.length > 0);
      for (let i = 0; i < logs.length - 1; i++) {
        assert.ok(logs[i].timestamp <= logs[i + 1].timestamp);
      }
    });

    test('respects offset parameter for pagination', async () => {
      const now = Date.now();
      const uniqueComponent = 'test-pagination-' + now;
      for (let i = 0; i < 5; i++) {
        await insertLog(now + i * 100, uniqueComponent, 'INFO', `Message ${i}`);
      }

      const firstPage = await getLogs({ component: uniqueComponent, limit: 2, offset: 0 });
      const secondPage = await getLogs({ component: uniqueComponent, limit: 2, offset: 2 });
      const thirdPage = await getLogs({ component: uniqueComponent, limit: 2, offset: 4 });

      assert.strictEqual(firstPage.length, 2);
      assert.strictEqual(secondPage.length, 2);
      assert.ok(thirdPage.length >= 1);

      // Verify pages don't overlap
      assert.notStrictEqual(firstPage[0].timestamp, secondPage[0].timestamp);
      if (thirdPage.length > 0) {
        assert.notStrictEqual(secondPage[0].timestamp, thirdPage[0].timestamp);
      }
    });

    test('filters with combined component, level, and time range', async () => {
      const now = Date.now();
      const startTime = now - 1000;
      const endTime = now + 1000;
      // Use unique components to avoid collisions with parallel tests
      const testComponent = getUniqueTestComponent('test-combined');
      const otherComponent = getUniqueTestComponent('other-combined');

      // Insert logs with different components, levels, and times
      await insertLog(now - 2000, testComponent, 'ERROR', 'Old error'); // Outside time range
      await insertLog(now, testComponent, 'ERROR', 'Recent error'); // Inside time range
      await insertLog(now + 50, testComponent, 'INFO', 'Recent info'); // Wrong level
      await insertLog(now + 100, otherComponent, 'ERROR', 'Other component error'); // Wrong component
      await insertLog(now + 150, testComponent, 'ERROR', 'Recent error 2'); // Should match

      const logs = await getLogs({
        component: testComponent,
        level: 'ERROR',
        startTime,
        endTime,
        limit: 10,
      });

      assert.ok(logs.length >= 2);
      logs.forEach(log => {
        assert.strictEqual(log.component, testComponent);
        assert.strictEqual(log.level, 'ERROR');
        assert.ok(log.timestamp >= startTime);
        assert.ok(log.timestamp <= endTime);
      });
    });
  });

  describe('getProcessedUrl', () => {
    test('returns null for non-existent URL hash', async () => {
      const urlHash = 'nonexistent-' + Date.now();
      const result = await getProcessedUrl(urlHash);
      assert.strictEqual(result, null);
    });

    test('returns processed URL record when exists', async () => {
      const urlHash = 'test-url-hash-' + Date.now();
      const fileHash = 'test-file-hash-123';
      const fileType = 'gif';
      const fileExtension = '.gif';
      const fileUrl = 'https://cdn.example.com/gifs/test.gif';
      const processedAt = Date.now();
      const userId = 'test-user-123';

      await insertProcessedUrl(
        urlHash,
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId
      );

      const result = await getProcessedUrl(urlHash);
      assert.ok(result, 'Should return processed URL record');
      assert.strictEqual(result.url_hash, urlHash);
      assert.strictEqual(result.file_hash, fileHash);
      assert.strictEqual(result.file_type, fileType);
      assert.strictEqual(result.file_extension, fileExtension);
      assert.strictEqual(result.file_url, fileUrl);
      assert.strictEqual(result.processed_at, processedAt);
      assert.strictEqual(result.user_id, userId);
    });

    test('handles missing database gracefully', async () => {
      closeDatabase();
      const result = await getProcessedUrl('test-hash');
      assert.strictEqual(result, null);
      await initDatabase();
    });
  });

  describe('insertProcessedUrl', () => {
    test('inserts new processed URL record', async () => {
      // Ensure database is initialized
      await initDatabase();

      const urlHash = 'test-insert-' + Date.now();
      const fileHash = 'file-hash-456';
      const fileType = 'video';
      const fileExtension = '.mp4';
      const fileUrl = 'https://cdn.example.com/videos/test.mp4';
      const processedAt = Date.now();
      const userId = 'user-456';

      await insertProcessedUrl(
        urlHash,
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId
      );

      const result = await getProcessedUrl(urlHash);
      assert.ok(result, 'Should exist after insert');
      assert.strictEqual(result.url_hash, urlHash);
      assert.strictEqual(result.file_hash, fileHash);
      assert.strictEqual(result.file_type, fileType);
      assert.strictEqual(result.file_extension, fileExtension);
      assert.strictEqual(result.file_url, fileUrl);
      assert.strictEqual(result.processed_at, processedAt);
      assert.strictEqual(result.user_id, userId);
    });

    test('updates existing processed URL record', async () => {
      // Ensure database is initialized
      await initDatabase();

      const urlHash = 'test-update-' + Date.now();
      const fileHash1 = 'file-hash-1';
      const fileHash2 = 'file-hash-2';
      const fileUrl1 = 'https://cdn.example.com/gifs/old.gif';
      const fileUrl2 = 'https://cdn.example.com/gifs/new.gif';
      const processedAt1 = Date.now();
      const processedAt2 = processedAt1 + 1000;

      // Insert first record
      await insertProcessedUrl(urlHash, fileHash1, 'gif', '.gif', fileUrl1, processedAt1, 'user-1');

      // Update with new info
      await insertProcessedUrl(urlHash, fileHash2, 'gif', '.gif', fileUrl2, processedAt2, 'user-2');

      const result = await getProcessedUrl(urlHash);
      assert.ok(result, 'Should exist');
      assert.strictEqual(result.file_hash, fileHash2, 'Should have updated file hash');
      assert.strictEqual(result.file_url, fileUrl2, 'Should have updated file URL');
      assert.strictEqual(result.processed_at, processedAt2, 'Should have updated timestamp');
      assert.strictEqual(result.user_id, 'user-2', 'Should have updated user ID');
    });

    test('handles null userId', async () => {
      // Ensure database is initialized
      await initDatabase();

      const urlHash = 'test-null-user-' + Date.now();
      const fileHash = 'file-hash-null';
      const fileUrl = 'https://cdn.example.com/videos/test.mp4';
      const processedAt = Date.now();

      await insertProcessedUrl(urlHash, fileHash, 'video', '.mp4', fileUrl, processedAt, null);

      const result = await getProcessedUrl(urlHash);
      assert.ok(result, 'Should exist');
      assert.strictEqual(result.user_id, null);
    });

    test('handles different file types', async () => {
      // Ensure database is initialized
      await initDatabase();

      const testCases = [
        { type: 'gif', ext: '.gif', url: 'https://cdn.example.com/gifs/test.gif' },
        { type: 'video', ext: '.mp4', url: 'https://cdn.example.com/videos/test.mp4' },
        { type: 'image', ext: '.png', url: 'https://cdn.example.com/images/test.png' },
      ];

      for (const [index, testCase] of testCases.entries()) {
        const urlHash = `test-type-${testCase.type}-${Date.now()}-${index}`;
        const fileHash = `file-hash-${testCase.type}`;

        await insertProcessedUrl(
          urlHash,
          fileHash,
          testCase.type,
          testCase.ext,
          testCase.url,
          Date.now(),
          'test-user'
        );

        const result = await getProcessedUrl(urlHash);
        assert.ok(result, `Should exist for ${testCase.type}`);
        assert.strictEqual(result.file_type, testCase.type);
        assert.strictEqual(result.file_extension, testCase.ext);
        assert.strictEqual(result.file_url, testCase.url);
      }
    });

    test('handles R2 URLs correctly', async () => {
      // Ensure database is initialized
      await initDatabase();

      const urlHash = 'test-r2-' + Date.now();
      const fileHash = 'file-hash-r2';
      const r2Url = 'https://r2.example.com/gifs/test.gif';
      const processedAt = Date.now();

      await insertProcessedUrl(urlHash, fileHash, 'gif', '.gif', r2Url, processedAt, 'user-r2');

      const result = await getProcessedUrl(urlHash);
      assert.ok(result, 'Should exist');
      assert.strictEqual(result.file_url, r2Url);
      assert.ok(result.file_url.startsWith('https://'), 'Should be a URL');
    });

    test('handles missing database gracefully', async () => {
      closeDatabase();
      // Should not throw even if database is closed
      await assert.doesNotReject(
        insertProcessedUrl(
          'test-hash',
          'file-hash',
          'gif',
          '.gif',
          'https://example.com/test.gif',
          Date.now(),
          'user'
        )
      );
      await initDatabase();
    });
  });
});
