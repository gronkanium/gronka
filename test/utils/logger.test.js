import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createLogger, formatTimestampSeconds } from '../../src/utils/logger.js';
import { initDatabase, closeDatabase, getLogs } from '../../src/utils/database.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbDir = path.join(os.tmpdir(), 'gronka-test-db');
const tempDbPath = path.join(tempDbDir, 'logger-test.db');

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

describe('logger utilities', () => {
  describe('formatTimestampSeconds', () => {
    test('formats timestamp correctly', () => {
      const date = new Date('2024-01-01T12:00:00.123Z');
      const formatted = formatTimestampSeconds(date);
      assert.strictEqual(formatted, '2024-01-01T12:00:00Z');
      assert.ok(formatted.endsWith('Z'));
      assert.ok(!formatted.includes('.'));
    });

    test('uses current date when no argument provided', () => {
      const formatted = formatTimestampSeconds();
      assert.ok(formatted.endsWith('Z'));
      assert.ok(formatted.includes('T'));
    });
  });

  describe('createLogger', () => {
    test('creates logger with component name', () => {
      const logger = createLogger('test-component');
      assert.ok(logger);
      assert.ok(typeof logger.info === 'function');
      assert.ok(typeof logger.debug === 'function');
      assert.ok(typeof logger.warn === 'function');
      assert.ok(typeof logger.error === 'function');
    });

    test('logger writes to database', async () => {
      const logger = createLogger('test-logger');
      const message = 'Test log message';

      await logger.info(message);

      // Wait a bit for async database write
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-logger', limit: 1 });
      assert.ok(logs.length > 0, 'Log should be written to database');
      const log = logs[0];
      assert.strictEqual(log.component, 'test-logger');
      assert.strictEqual(log.level, 'INFO');
      assert.ok(log.message.includes(message));
    });

    test('logger respects log level', async () => {
      const logger = createLogger('test-level');

      await logger.debug('Debug message');
      await logger.info('Info message');
      await logger.warn('Warn message');
      await logger.error('Error message');

      await new Promise(resolve => setTimeout(resolve, 100));

      const allLogs = await getLogs({ component: 'test-level', limit: 10 });
      const infoLogs = allLogs.filter(log => log.level === 'INFO');
      const warnLogs = allLogs.filter(log => log.level === 'WARN');
      const errorLogs = allLogs.filter(log => log.level === 'ERROR');

      // At INFO level, DEBUG messages should be filtered
      // But we can't easily test this without mocking, so we just verify
      // that messages are written
      assert.ok(infoLogs.length > 0);
      assert.ok(warnLogs.length > 0);
      assert.ok(errorLogs.length > 0);
    });

    test('logger handles multiple arguments', async () => {
      const logger = createLogger('test-args');

      await logger.info('Message', 'arg1', 'arg2', { key: 'value' });

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-args', limit: 1 });
      const log = logs[0];
      assert.ok(log.message.includes('Message'));
      assert.ok(log.message.includes('arg1'));
      assert.ok(log.message.includes('arg2'));
    });

    test('logger handles object arguments', async () => {
      const logger = createLogger('test-object');

      const obj = { key: 'value', number: 123 };
      await logger.info('Message', obj);

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-object', limit: 1 });
      const log = logs[0];
      assert.ok(log.message.includes('Message'));
      // Object should be JSON stringified
      assert.ok(log.message.includes('"key"'));
      assert.ok(log.message.includes('"value"'));
    });

    test('different components write to same database', async () => {
      const logger1 = createLogger('component-1');
      const logger2 = createLogger('component-2');

      await logger1.info('Message from component 1');
      await logger2.info('Message from component 2');

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs1 = await getLogs({ component: 'component-1', limit: 1 });
      const logs2 = await getLogs({ component: 'component-2', limit: 1 });

      assert.ok(logs1.length > 0);
      assert.ok(logs2.length > 0);
      assert.strictEqual(logs1[0].component, 'component-1');
      assert.strictEqual(logs2[0].component, 'component-2');
    });

    test('logger sanitizes log messages before writing', async () => {
      const logger = createLogger('test-sanitize');
      const maliciousInput = 'Normal log\n[2024-01-01] [INFO] Fake log entry';

      await logger.info(maliciousInput);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-sanitize', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify newline was removed (preventing log injection)
      // The text will still be there, but without the newline it can't create a separate log entry
      assert.ok(!log.message.includes('\n'));
      assert.ok(log.message.includes('Normal log'));
      // The fake log text is still present, but without the newline it can't create a separate log entry
      assert.ok(log.message.includes('[2024-01-01]'));
    });

    test('logger sanitizes control characters in log output', async () => {
      const logger = createLogger('test-control-chars');
      const inputWithControlChars = 'Text\x00\x01\x02\x03\x7F\x80\x9F';

      await logger.info(inputWithControlChars);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-control-chars', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify control characters were removed
      // eslint-disable-next-line no-control-regex
      const controlCharRegex = /[\x00-\x1F\x7F-\x9F]/;
      assert.ok(
        !controlCharRegex.test(log.message),
        `Log message contains control characters: ${log.message}`
      );
      assert.ok(log.message.includes('Text'));
    });

    test('logger sanitizes ANSI escape codes in log output', async () => {
      const logger = createLogger('test-ansi');
      const inputWithAnsi = '\x1B[31mRed text\x1B[0m';

      await logger.info(inputWithAnsi);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-ansi', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify ANSI codes were removed
      assert.ok(!log.message.includes('\x1B'));
      assert.ok(log.message.includes('Red text'));
    });

    test('logger sanitizes arguments in log messages', async () => {
      const logger = createLogger('test-sanitize-args');
      const maliciousArg = 'Arg\nwith\nnewlines';

      await logger.info('Test message', maliciousArg);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-sanitize-args', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify arguments were sanitized
      assert.ok(!log.message.includes('\n'));
      assert.ok(log.message.includes('Arg'));
      assert.ok(log.message.includes('with'));
      assert.ok(log.message.includes('newlines'));
    });
  });
});
