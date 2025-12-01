import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createLogger } from '../../src/utils/logger.js';
import { initDatabase, closeDatabase, getLogs } from '../../src/utils/database.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbDir = path.join(os.tmpdir(), 'gronka-test-db');
const tempDbPath = path.join(tempDbDir, 'logger-sanitization-test.db');

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

describe('logger sanitization', () => {
  describe('sanitizeLogInput', () => {
    test('removes ANSI escape codes', () => {
      const logger = createLogger('test-sanitize');
      const input = '\x1B[31mRed text\x1B[0m';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Red text');
      assert.ok(!sanitized.includes('\x1B'));
    });

    test('removes newlines', () => {
      const logger = createLogger('test-sanitize');
      const input = 'Line 1\nLine 2';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Line 1 Line 2');
      assert.ok(!sanitized.includes('\n'));
    });

    test('removes carriage returns', () => {
      const logger = createLogger('test-sanitize');
      const input = 'Line 1\rLine 2';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Line 1 Line 2');
      assert.ok(!sanitized.includes('\r'));
    });

    test('removes tabs', () => {
      const logger = createLogger('test-sanitize');
      const input = 'Text\twith\ttabs';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Text with tabs');
      assert.ok(!sanitized.includes('\t'));
    });

    test('removes all control characters', () => {
      const logger = createLogger('test-sanitize');
      // Test various control characters (0x00-0x1F and 0x7F-0x9F)
      const input = 'Text\x00\x01\x02\x03\x7F\x80\x9F';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Text');
      // Verify no control characters remain
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\x00-\x1F\x7F-\x9F]/.test(sanitized));
    });

    test('removes complex ANSI escape sequences', () => {
      const logger = createLogger('test-sanitize');
      const input = '\x1B[1;33;40mBold yellow on black\x1B[0m';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Bold yellow on black');
      assert.ok(!sanitized.includes('\x1B'));
    });

    test('trims whitespace', () => {
      const logger = createLogger('test-sanitize');
      const input = '  Text with spaces  ';
      const sanitized = logger.sanitizeLogInput(input);
      assert.strictEqual(sanitized, 'Text with spaces');
    });

    test('handles null input', () => {
      const logger = createLogger('test-sanitize');
      const sanitized = logger.sanitizeLogInput(null);
      assert.strictEqual(sanitized, null);
    });

    test('handles undefined input', () => {
      const logger = createLogger('test-sanitize');
      const sanitized = logger.sanitizeLogInput(undefined);
      assert.strictEqual(sanitized, undefined);
    });

    test('handles non-string input', () => {
      const logger = createLogger('test-sanitize');
      const obj = { key: 'value' };
      const sanitized = logger.sanitizeLogInput(obj);
      assert.strictEqual(sanitized, obj);
    });

    test('handles empty string', () => {
      const logger = createLogger('test-sanitize');
      const sanitized = logger.sanitizeLogInput('');
      assert.strictEqual(sanitized, '');
    });

    test('prevents log injection with newline', async () => {
      const logger = createLogger('test-injection');
      const maliciousInput = 'Normal log\n[2024-01-01] [INFO] Fake log entry';

      await logger.info(maliciousInput);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-injection', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify newline was removed (preventing log injection)
      // The text will still be there, but the newline that could create a fake log entry is removed
      assert.ok(!log.message.includes('\n'));
      assert.ok(log.message.includes('Normal log'));
      // The fake log text is still present, but without the newline it can't create a separate log entry
      assert.ok(log.message.includes('[2024-01-01]'));
    });

    test('prevents log injection with ANSI codes', async () => {
      const logger = createLogger('test-injection-ansi');
      const maliciousInput = '\x1B[31mFake error\x1B[0m';

      await logger.info(maliciousInput);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-injection-ansi', limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify ANSI codes were removed
      assert.ok(!log.message.includes('\x1B'));
      assert.ok(log.message.includes('Fake error'));
    });

    test('sanitizes log messages in formatMessage', () => {
      const logger = createLogger('test-format');
      const message = 'Test\nmessage';
      const formatted = logger.formatMessage(1, message);

      // Verify message was sanitized (no newline in formatted output)
      assert.ok(!formatted.includes('\n'));
      assert.ok(formatted.includes('Test'));
      assert.ok(formatted.includes('message'));
    });

    test('sanitizes arguments in formatMessage', () => {
      const logger = createLogger('test-format-args');
      const message = 'Test message';
      const arg1 = 'Arg\nwith\nnewlines';
      const formatted = logger.formatMessage(1, message, arg1);

      // Verify arguments were sanitized
      assert.ok(!formatted.includes('\n'));
      assert.ok(formatted.includes('Arg'));
      assert.ok(formatted.includes('with'));
      assert.ok(formatted.includes('newlines'));
    });

    test('sanitizes object arguments in formatMessage', () => {
      const logger = createLogger('test-format-obj');
      const message = 'Test message';
      const obj = { key: 'value\nwith\nnewline' };
      const formatted = logger.formatMessage(1, message, obj);

      // Verify object was stringified and sanitized
      assert.ok(!formatted.includes('\n'));
      assert.ok(formatted.includes('value'));
      assert.ok(formatted.includes('with'));
      assert.ok(formatted.includes('newline'));
    });

    test('sanitizes in all log methods', async () => {
      const logger = createLogger('test-all-methods');
      const maliciousInput = 'Test\x00\x01\n\r\tmessage';

      await logger.debug(maliciousInput);
      await logger.info(maliciousInput);
      await logger.warn(maliciousInput);
      await logger.error(maliciousInput);

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: 'test-all-methods', limit: 10 });
      assert.ok(logs.length >= 3); // At least INFO, WARN, ERROR (DEBUG may be filtered)

      // Verify all log entries are sanitized
      for (const log of logs) {
        // eslint-disable-next-line no-control-regex
        const controlCharRegex = /[\x00-\x1F\x7F-\x9F]/;
        assert.ok(
          !controlCharRegex.test(log.message),
          `Log message contains control characters: ${log.message}`
        );
        assert.ok(log.message.includes('Test'));
        assert.ok(log.message.includes('message'));
      }
    });
  });
});
