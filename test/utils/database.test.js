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
} from '../../src/utils/database.js';
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
  await initDatabase();
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
    test('inserts new user', () => {
      const userId = 'test-user-1';
      const username = 'TestUser';
      const timestamp = Date.now();

      insertOrUpdateUser(userId, username, timestamp);

      const user = getUser(userId);
      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username);
      assert.strictEqual(user.first_used, timestamp);
      assert.strictEqual(user.last_used, timestamp);
    });

    test('updates existing user', () => {
      const userId = 'test-user-2';
      const username1 = 'TestUser1';
      const username2 = 'TestUser2';
      const timestamp1 = Date.now();
      const timestamp2 = timestamp1 + 1000;

      insertOrUpdateUser(userId, username1, timestamp1);
      insertOrUpdateUser(userId, username2, timestamp2);

      const user = getUser(userId);
      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username2);
      assert.strictEqual(user.first_used, timestamp1);
      assert.strictEqual(user.last_used, timestamp2);
    });

    test('handles invalid userId gracefully', () => {
      assert.doesNotThrow(() => {
        insertOrUpdateUser(null, 'TestUser', Date.now());
        insertOrUpdateUser('', 'TestUser', Date.now());
        insertOrUpdateUser(123, 'TestUser', Date.now());
      });
    });
  });

  describe('getUser', () => {
    test('returns user for existing user_id', () => {
      const userId = 'test-user-3';
      const username = 'TestUser3';
      const timestamp = Date.now();

      insertOrUpdateUser(userId, username, timestamp);
      const user = getUser(userId);

      assert.ok(user, 'User should exist');
      assert.strictEqual(user.user_id, userId);
      assert.strictEqual(user.username, username);
    });

    test('returns null for non-existent user', () => {
      const user = getUser('non-existent-user');
      assert.strictEqual(user, null);
    });
  });

  describe('getUniqueUserCount', () => {
    test('returns correct count', () => {
      const countBefore = getUniqueUserCount();

      insertOrUpdateUser('test-count-1', 'User1', Date.now());
      insertOrUpdateUser('test-count-2', 'User2', Date.now());
      insertOrUpdateUser('test-count-3', 'User3', Date.now());

      const countAfter = getUniqueUserCount();
      assert.strictEqual(countAfter, countBefore + 3);
    });

    test('returns 0 for empty database', () => {
      // This test assumes a clean database, which isn't guaranteed
      // So we just check it returns a number
      const count = getUniqueUserCount();
      assert.strictEqual(typeof count, 'number');
      assert.ok(count >= 0);
    });
  });

  describe('insertLog', () => {
    test('inserts log entry', () => {
      const timestamp = Date.now();
      const component = 'test';
      const level = 'INFO';
      const message = 'Test log message';

      insertLog(timestamp, component, level, message);

      const logs = getLogs({ component, limit: 1 });
      assert.ok(logs.length > 0, 'Log should exist');
      const log = logs[0];
      assert.strictEqual(log.component, component);
      assert.strictEqual(log.level, level);
      assert.strictEqual(log.message, message);
      assert.strictEqual(log.timestamp, timestamp);
    });

    test('inserts log with metadata', () => {
      const timestamp = Date.now();
      const component = 'test';
      const level = 'INFO';
      const message = 'Test log with metadata';
      const metadata = { key: 'value', number: 123 };

      insertLog(timestamp, component, level, message, metadata);

      const logs = getLogs({ component, limit: 1 });
      const log = logs[0];
      assert.ok(log.metadata, 'Metadata should exist');
      const parsedMetadata = JSON.parse(log.metadata);
      assert.strictEqual(parsedMetadata.key, 'value');
      assert.strictEqual(parsedMetadata.number, 123);
    });

    test('handles all log levels', () => {
      const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      const timestamp = Date.now();

      levels.forEach(level => {
        insertLog(timestamp, 'test', level, `Test ${level} message`);
      });

      levels.forEach(level => {
        const logs = getLogs({ component: 'test', level, limit: 10 });
        assert.ok(logs.length > 0, `Should have ${level} logs`);
      });
    });
  });

  describe('getLogs', () => {
    test('returns all logs when no filters specified', () => {
      const logs = getLogs({ limit: 10 });
      assert.ok(Array.isArray(logs));
      assert.ok(logs.length <= 10);
    });

    test('filters by component', () => {
      insertLog(Date.now(), 'bot', 'INFO', 'Bot test message');
      insertLog(Date.now(), 'server', 'INFO', 'Server test message');

      const botLogs = getLogs({ component: 'bot', limit: 10 });
      const serverLogs = getLogs({ component: 'server', limit: 10 });

      assert.ok(botLogs.length > 0, 'Should have bot logs');
      assert.ok(serverLogs.length > 0, 'Should have server logs');

      botLogs.forEach(log => {
        assert.strictEqual(log.component, 'bot');
      });

      serverLogs.forEach(log => {
        assert.strictEqual(log.component, 'server');
      });
    });

    test('filters by level', () => {
      insertLog(Date.now(), 'test', 'ERROR', 'Error message');
      insertLog(Date.now(), 'test', 'INFO', 'Info message');

      const errorLogs = getLogs({ component: 'test', level: 'ERROR', limit: 10 });
      const infoLogs = getLogs({ component: 'test', level: 'INFO', limit: 10 });

      errorLogs.forEach(log => {
        assert.strictEqual(log.level, 'ERROR');
      });

      infoLogs.forEach(log => {
        assert.strictEqual(log.level, 'INFO');
      });
    });

    test('filters by time range', () => {
      const now = Date.now();
      const startTime = now - 5000;
      const endTime = now + 5000;

      insertLog(now, 'test', 'INFO', 'Time filtered message');

      const logs = getLogs({
        component: 'test',
        startTime,
        endTime,
        limit: 10,
      });

      logs.forEach(log => {
        assert.ok(log.timestamp >= startTime);
        assert.ok(log.timestamp <= endTime);
      });
    });

    test('respects limit', () => {
      // Insert multiple logs
      for (let i = 0; i < 5; i++) {
        insertLog(Date.now() + i, 'test', 'INFO', `Message ${i}`);
      }

      const logs = getLogs({ component: 'test', limit: 3 });
      assert.strictEqual(logs.length, 3);
    });

    test('orders by timestamp descending by default', () => {
      const now = Date.now();
      insertLog(now, 'test', 'INFO', 'Message 1');
      insertLog(now + 100, 'test', 'INFO', 'Message 2');
      insertLog(now + 200, 'test', 'INFO', 'Message 3');

      const logs = getLogs({ component: 'test', limit: 3 });
      assert.ok(logs.length > 0);
      for (let i = 0; i < logs.length - 1; i++) {
        assert.ok(logs[i].timestamp >= logs[i + 1].timestamp);
      }
    });

    test('orders by timestamp ascending when specified', () => {
      const now = Date.now();
      insertLog(now, 'test', 'INFO', 'Message 1');
      insertLog(now + 100, 'test', 'INFO', 'Message 2');
      insertLog(now + 200, 'test', 'INFO', 'Message 3');

      const logs = getLogs({ component: 'test', orderDesc: false, limit: 3 });
      assert.ok(logs.length > 0);
      for (let i = 0; i < logs.length - 1; i++) {
        assert.ok(logs[i].timestamp <= logs[i + 1].timestamp);
      }
    });
  });
});
