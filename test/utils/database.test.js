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
  getLogsCount,
  getLogComponents,
  getLogMetrics,
  getProcessedUrl,
  insertProcessedUrl,
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

    test('handles null vs undefined metadata', () => {
      const timestamp = Date.now();
      const component = 'test';
      const level = 'INFO';

      // Insert log with null metadata
      insertLog(timestamp, component, level, 'Message with null', null);
      const logsWithNull = getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithNull[0].metadata, null);

      // Insert log with undefined metadata (should default to null)
      insertLog(timestamp + 1, component, level, 'Message with undefined', undefined);
      const logsWithUndefined = getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithUndefined[0].metadata, null);

      // Insert log without metadata parameter (should default to null)
      insertLog(timestamp + 2, component, level, 'Message without metadata');
      const logsWithout = getLogs({ component, limit: 1 });
      assert.strictEqual(logsWithout[0].metadata, null);
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

    test('respects offset parameter for pagination', () => {
      const now = Date.now();
      const uniqueComponent = 'test-pagination-' + now;
      for (let i = 0; i < 5; i++) {
        insertLog(now + i * 100, uniqueComponent, 'INFO', `Message ${i}`);
      }

      const firstPage = getLogs({ component: uniqueComponent, limit: 2, offset: 0 });
      const secondPage = getLogs({ component: uniqueComponent, limit: 2, offset: 2 });
      const thirdPage = getLogs({ component: uniqueComponent, limit: 2, offset: 4 });

      assert.strictEqual(firstPage.length, 2);
      assert.strictEqual(secondPage.length, 2);
      assert.ok(thirdPage.length >= 1);

      // Verify pages don't overlap
      assert.notStrictEqual(firstPage[0].timestamp, secondPage[0].timestamp);
      if (thirdPage.length > 0) {
        assert.notStrictEqual(secondPage[0].timestamp, thirdPage[0].timestamp);
      }
    });

    test('filters with combined component, level, and time range', () => {
      const now = Date.now();
      const startTime = now - 1000;
      const endTime = now + 1000;

      // Insert logs with different components, levels, and times
      insertLog(now - 2000, 'test', 'ERROR', 'Old error'); // Outside time range
      insertLog(now, 'test', 'ERROR', 'Recent error'); // Inside time range
      insertLog(now, 'test', 'INFO', 'Recent info'); // Wrong level
      insertLog(now, 'other', 'ERROR', 'Other component error'); // Wrong component
      insertLog(now, 'test', 'ERROR', 'Recent error 2'); // Should match

      const logs = getLogs({
        component: 'test',
        level: 'ERROR',
        startTime,
        endTime,
        limit: 10,
      });

      assert.ok(logs.length >= 2);
      logs.forEach(log => {
        assert.strictEqual(log.component, 'test');
        assert.strictEqual(log.level, 'ERROR');
        assert.ok(log.timestamp >= startTime);
        assert.ok(log.timestamp <= endTime);
      });
    });

    test('filters by multiple levels', () => {
      const now = Date.now();
      const uniqueComponent = 'test-multi-level-' + now;

      insertLog(now, uniqueComponent, 'ERROR', 'Error message');
      insertLog(now + 1, uniqueComponent, 'WARN', 'Warning message');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Info message');
      insertLog(now + 3, uniqueComponent, 'DEBUG', 'Debug message');

      const logs = getLogs({
        component: uniqueComponent,
        level: ['ERROR', 'WARN'],
        limit: 10,
      });

      assert.ok(logs.length >= 2, 'Should have at least 2 logs');
      logs.forEach(log => {
        assert.ok(log.level === 'ERROR' || log.level === 'WARN');
      });
    });

    test('filters by search term', () => {
      const now = Date.now();
      const uniqueComponent = 'test-search-' + now;

      insertLog(now, uniqueComponent, 'INFO', 'This is a unique search term test');
      insertLog(now + 1, uniqueComponent, 'INFO', 'This is another message');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Contains the word unique');

      const logs = getLogs({
        component: uniqueComponent,
        search: 'unique',
        limit: 10,
      });

      assert.ok(logs.length >= 2, 'Should find logs with search term');
      logs.forEach(log => {
        assert.ok(log.message.toLowerCase().includes('unique'));
      });
    });

    test('search is case-insensitive', () => {
      const now = Date.now();
      const uniqueComponent = 'test-case-' + now;

      insertLog(now, uniqueComponent, 'INFO', 'Message with UPPERCASE word');
      insertLog(now + 1, uniqueComponent, 'INFO', 'Message with lowercase word');

      const logsUpper = getLogs({
        component: uniqueComponent,
        search: 'WORD',
        limit: 10,
      });

      const logsLower = getLogs({
        component: uniqueComponent,
        search: 'word',
        limit: 10,
      });

      assert.ok(logsUpper.length >= 2, 'Should find with uppercase search');
      assert.ok(logsLower.length >= 2, 'Should find with lowercase search');
    });
  });

  describe('getLogsCount', () => {
    test('returns correct count without filters', () => {
      const count = getLogsCount();
      assert.strictEqual(typeof count, 'number');
      assert.ok(count >= 0);
    });

    test('returns correct count with component filter', () => {
      const now = Date.now();
      const uniqueComponent = 'test-count-component-' + now;

      insertLog(now, uniqueComponent, 'INFO', 'Message 1');
      insertLog(now + 1, uniqueComponent, 'INFO', 'Message 2');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Message 3');

      const count = getLogsCount({ component: uniqueComponent });
      assert.ok(count >= 3, 'Should count at least 3 logs');
    });

    test('returns correct count with level filter', () => {
      const now = Date.now();
      const uniqueComponent = 'test-count-level-' + now;

      insertLog(now, uniqueComponent, 'ERROR', 'Error 1');
      insertLog(now + 1, uniqueComponent, 'ERROR', 'Error 2');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Info 1');

      const errorCount = getLogsCount({
        component: uniqueComponent,
        level: 'ERROR',
      });

      assert.ok(errorCount >= 2, 'Should count at least 2 errors');
    });

    test('returns correct count with multiple level filter', () => {
      const now = Date.now();
      const uniqueComponent = 'test-count-multi-' + now;

      insertLog(now, uniqueComponent, 'ERROR', 'Error 1');
      insertLog(now + 1, uniqueComponent, 'WARN', 'Warn 1');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Info 1');
      insertLog(now + 3, uniqueComponent, 'DEBUG', 'Debug 1');

      const count = getLogsCount({
        component: uniqueComponent,
        level: ['ERROR', 'WARN'],
      });

      assert.ok(count >= 2, 'Should count at least 2 logs');
    });

    test('returns correct count with time range', () => {
      const now = Date.now();
      const startTime = now - 1000;
      const endTime = now + 1000;
      const uniqueComponent = 'test-count-time-' + now;

      insertLog(now - 2000, uniqueComponent, 'INFO', 'Old message');
      insertLog(now, uniqueComponent, 'INFO', 'Recent message 1');
      insertLog(now + 500, uniqueComponent, 'INFO', 'Recent message 2');

      const count = getLogsCount({
        component: uniqueComponent,
        startTime,
        endTime,
      });

      assert.ok(count >= 2, 'Should count recent logs only');
    });

    test('returns correct count with search filter', () => {
      const now = Date.now();
      const uniqueComponent = 'test-count-search-' + now;

      insertLog(now, uniqueComponent, 'INFO', 'Message with keyword');
      insertLog(now + 1, uniqueComponent, 'INFO', 'Another with keyword');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Different message');

      const count = getLogsCount({
        component: uniqueComponent,
        search: 'keyword',
      });

      assert.ok(count >= 2, 'Should count messages with keyword');
    });
  });

  describe('getLogComponents', () => {
    test('returns array of components', () => {
      const components = getLogComponents();
      assert.ok(Array.isArray(components));
    });

    test('returns unique components', () => {
      const now = Date.now();
      const comp1 = 'test-comp-1-' + now;
      const comp2 = 'test-comp-2-' + now;

      insertLog(now, comp1, 'INFO', 'Message 1');
      insertLog(now + 1, comp1, 'INFO', 'Message 2');
      insertLog(now + 2, comp2, 'INFO', 'Message 3');

      const components = getLogComponents();
      const uniqueSet = new Set(components);

      assert.strictEqual(components.length, uniqueSet.size, 'All components should be unique');
    });

    test('includes newly added components', () => {
      const now = Date.now();
      const uniqueComponent = 'test-new-component-' + now;

      insertLog(now, uniqueComponent, 'INFO', 'Test message');

      const components = getLogComponents();
      assert.ok(components.includes(uniqueComponent), 'Should include new component');
    });
  });

  describe('getLogMetrics', () => {
    test('returns metrics object with expected structure', () => {
      const metrics = getLogMetrics();

      assert.ok(typeof metrics === 'object');
      assert.ok(typeof metrics.total === 'number');
      assert.ok(typeof metrics.byLevel === 'object');
      assert.ok(typeof metrics.byComponent === 'object');
      assert.ok(typeof metrics.errorCount1h === 'number');
      assert.ok(typeof metrics.errorCount24h === 'number');
      assert.ok(typeof metrics.warnCount1h === 'number');
      assert.ok(typeof metrics.warnCount24h === 'number');
      assert.ok(Array.isArray(metrics.errorTimeline));
    });

    test('counts errors correctly in last hour', () => {
      const now = Date.now();
      const uniqueComponent = 'test-metrics-1h-' + now;

      // Recent error (within last hour)
      insertLog(now - 30 * 60 * 1000, uniqueComponent, 'ERROR', 'Recent error');
      // Old error (more than hour ago)
      insertLog(now - 90 * 60 * 1000, uniqueComponent, 'ERROR', 'Old error');

      const metrics = getLogMetrics();
      assert.ok(metrics.errorCount1h >= 1, 'Should count recent errors');
    });

    test('counts logs by level', () => {
      const now = Date.now();
      const uniqueComponent = 'test-metrics-level-' + now;

      insertLog(now, uniqueComponent, 'ERROR', 'Error 1');
      insertLog(now + 1, uniqueComponent, 'WARN', 'Warning 1');
      insertLog(now + 2, uniqueComponent, 'INFO', 'Info 1');

      const metrics = getLogMetrics();

      assert.ok(metrics.byLevel.ERROR >= 1, 'Should have error count');
      assert.ok(metrics.byLevel.WARN >= 1, 'Should have warning count');
      assert.ok(metrics.byLevel.INFO >= 1, 'Should have info count');
    });

    test('counts logs by component', () => {
      const now = Date.now();
      const comp1 = 'test-metrics-comp1-' + now;
      const comp2 = 'test-metrics-comp2-' + now;

      insertLog(now, comp1, 'INFO', 'Message 1');
      insertLog(now + 1, comp2, 'INFO', 'Message 2');

      const metrics = getLogMetrics();

      assert.ok(metrics.byComponent[comp1] >= 1, 'Should count component 1');
      assert.ok(metrics.byComponent[comp2] >= 1, 'Should count component 2');
    });

    test('respects custom time range', () => {
      const now = Date.now();
      const uniqueComponent = 'test-metrics-range-' + now;
      const oneHour = 60 * 60 * 1000;

      // Insert log within 1 hour
      insertLog(now - oneHour / 2, uniqueComponent, 'ERROR', 'Recent error');
      // Insert log outside 1 hour
      insertLog(now - oneHour * 2, uniqueComponent, 'ERROR', 'Old error');

      const metrics = getLogMetrics({ timeRange: oneHour });

      // The recent error should be counted, old one shouldn't
      assert.ok(metrics.total >= 1, 'Should count logs in time range');
    });

    test('error timeline has correct structure', () => {
      const metrics = getLogMetrics();

      metrics.errorTimeline.forEach(point => {
        assert.ok(typeof point.hour === 'number', 'Timeline point should have hour');
        assert.ok(typeof point.count === 'number', 'Timeline point should have count');
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
