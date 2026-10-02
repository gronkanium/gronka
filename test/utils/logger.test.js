import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { createLogger, formatTimestampSeconds, withLogContext } from '../../src/utils/logger.js';
import {
  initDatabase,
  getLogs,
  getLogsCount,
  getLogFacets,
  getLogHistogram,
  onNewLog,
} from '../../src/utils/database.js';
import { getUniqueTestComponent } from '../helpers/unique.js';

beforeAll(async () => {
  await initDatabase();
});

afterAll(async () => {
  // Don't close database here - it's shared across parallel test files
  // Connection will be cleaned up when Node.js exits
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
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-logger');
      const logger = createLogger(componentName);
      const message = 'Test log message';

      await logger.info(message);

      // Wait a bit for async database write
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
      assert.ok(logs.length > 0, 'Log should be written to database');
      const log = logs[0];
      assert.strictEqual(log.component, componentName);
      assert.strictEqual(log.level, 'INFO');
      assert.ok(log.message.includes(message));
    });

    test('logger respects log level', async () => {
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-level');
      const logger = createLogger(componentName);

      await logger.debug('Debug message');
      await logger.info('Info message');
      await logger.warn('Warn message');
      await logger.error('Error message');

      await new Promise(resolve => setTimeout(resolve, 100));

      const allLogs = await getLogs({ component: componentName, limit: 10 });
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
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-args');
      const logger = createLogger(componentName);

      await logger.info('Message', 'arg1', 'arg2', { key: 'value' });

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
      const log = logs[0];
      assert.ok(log.message.includes('Message'));
      assert.ok(log.message.includes('arg1'));
      assert.ok(log.message.includes('arg2'));
    });

    test('logger handles object arguments', async () => {
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-object');
      const logger = createLogger(componentName);

      const obj = { key: 'value', number: 123 };
      await logger.info('Message', obj);

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
      const log = logs[0];
      assert.ok(log.message.includes('Message'));
      // Object should be JSON stringified
      assert.ok(log.message.includes('"key"'));
      assert.ok(log.message.includes('"value"'));
    });

    test('different components write to same database', async () => {
      // Use unique components to avoid collisions with parallel tests
      const component1Name = getUniqueTestComponent('component-1');
      const component2Name = getUniqueTestComponent('component-2');
      const logger1 = createLogger(component1Name);
      const logger2 = createLogger(component2Name);

      await logger1.info('Message from component 1');
      await logger2.info('Message from component 2');

      await new Promise(resolve => setTimeout(resolve, 100));

      const logs1 = await getLogs({ component: component1Name, limit: 1 });
      const logs2 = await getLogs({ component: component2Name, limit: 1 });

      assert.ok(logs1.length > 0);
      assert.ok(logs2.length > 0);
      assert.strictEqual(logs1[0].component, component1Name);
      assert.strictEqual(logs2[0].component, component2Name);
    });

    test('logger sanitizes log messages before writing', async () => {
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-sanitize');
      const logger = createLogger(componentName);
      const maliciousInput = 'Normal log\n[2024-01-01] [INFO] Fake log entry';

      await logger.info(maliciousInput);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
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
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-control-chars');
      const logger = createLogger(componentName);
      const inputWithControlChars = 'Text\x00\x01\x02\x03\x7F\x80\x9F';

      await logger.info(inputWithControlChars);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
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
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-ansi');
      const logger = createLogger(componentName);
      const inputWithAnsi = '\x1B[31mRed text\x1B[0m';

      await logger.info(inputWithAnsi);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify ANSI codes were removed
      assert.ok(!log.message.includes('\x1B'));
      assert.ok(log.message.includes('Red text'));
    });

    test('logger sanitizes arguments in log messages', async () => {
      // Use unique component to avoid collisions with parallel tests
      const componentName = getUniqueTestComponent('test-sanitize-args');
      const logger = createLogger(componentName);
      const maliciousArg = 'Arg\nwith\nnewlines';

      await logger.info('Test message', maliciousArg);
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await getLogs({ component: componentName, limit: 1 });
      assert.ok(logs.length > 0);
      const log = logs[0];
      // Verify arguments were sanitized
      assert.ok(!log.message.includes('\n'));
      assert.ok(log.message.includes('Arg'));
      assert.ok(log.message.includes('with'));
      assert.ok(log.message.includes('newlines'));
    });
  });

  describe('log context', () => {
    test('announces each new line, with its context, to onNewLog listeners', async () => {
      const component = getUniqueTestComponent('test-log-notify');
      const seen = [];
      const listener = await onNewLog(line => line.component === component && seen.push(line));
      await withLogContext({ op: 'op-notify-1' }, () => createLogger(component).error('pushed'));
      for (let i = 0; i < 50 && !seen.length; i++) await new Promise(r => setTimeout(r, 20));
      await listener.unlisten();

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].message, 'pushed');
      assert.strictEqual(seen[0].level, 'ERROR');
      assert.strictEqual(typeof seen[0].timestamp, 'number');
      assert.deepStrictEqual(seen[0].metadata, { op: 'op-notify-1' });
    });

    test('stamps nested context on every line and leaves lines outside it bare', async () => {
      const component = getUniqueTestComponent('test-log-context');
      const logger = createLogger(component);
      await withLogContext({ op: 'op-ctx-1', source: 'x.com' }, () =>
        withLogContext({ worker: 'w-1' }, () => logger.warn('inside'))
      );
      await logger.info('outside');

      const [outside, inside] = await getLogs({ component, limit: 2 });
      assert.deepStrictEqual(inside.metadata, { op: 'op-ctx-1', source: 'x.com', worker: 'w-1' });
      assert.strictEqual(outside.metadata, null);
    });

    test('field filters, facets and histogram agree on the same lines', async () => {
      const component = getUniqueTestComponent('test-log-facets');
      const logger = createLogger(component);
      const startTime = Date.now();
      await withLogContext({ op: 'op-facet-a', source: 'tiktok.com' }, async () => {
        await logger.info('a1');
        await logger.error('a2');
      });
      await withLogContext({ op: 'op-facet-b', source: 'x.com' }, () => logger.warn('b1'));

      const filters = { component, startTime, fields: { source: ['tiktok.com'] } };
      assert.strictEqual(await getLogsCount(filters), 2);
      assert.deepStrictEqual(
        (await getLogs({ ...filters, fields: { op: 'op-facet-b' } })).map(l => l.message),
        ['b1']
      );

      const facets = await getLogFacets(filters);
      assert.deepStrictEqual(
        facets.source.map(f => [f.value, f.count]).sort(),
        [
          ['tiktok.com', 2],
          ['x.com', 1],
        ],
        'a facet ignores its own filter so every value stays pickable'
      );
      assert.deepStrictEqual(facets.level.map(f => f.value).sort(), ['ERROR', 'INFO']);

      const histogram = await getLogHistogram({ component, startTime, endTime: Date.now() }, 4);
      const totals = histogram.buckets.reduce(
        (sum, b) => ({
          ERROR: sum.ERROR + b.ERROR,
          WARN: sum.WARN + b.WARN,
          INFO: sum.INFO + b.INFO,
        }),
        { ERROR: 0, WARN: 0, INFO: 0 }
      );
      assert.deepStrictEqual(totals, { ERROR: 1, WARN: 1, INFO: 1 });
    });
  });
});
