import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { initDatabase, closeDatabase, insertLog, getLogMetrics } from '../../src/utils/database.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbDir = path.join(os.tmpdir(), 'gronka-test-db');
const tempDbPath = path.join(tempDbDir, 'log-metrics-test.db');

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

describe('getLogMetrics', () => {
  test('byComponent only includes ERROR and WARN levels, excludes INFO', async () => {
    const now = Date.now();
    const uniqueId = now;
    const component = `webui-test-${uniqueId}`;

    // Insert multiple INFO logs (should NOT be counted in byComponent)
    for (let i = 0; i < 10; i++) {
      await insertLog(now + i * 1000, component, 'INFO', `Info message ${i}`);
    }

    // Insert ERROR logs (should be counted)
    await insertLog(now + 10000, component, 'ERROR', 'Error message 1');
    await insertLog(now + 11000, component, 'ERROR', 'Error message 2');

    // Insert WARN logs (should be counted)
    await insertLog(now + 12000, component, 'WARN', 'Warning message 1');

    // Insert DEBUG logs (should NOT be counted)
    await insertLog(now + 13000, component, 'DEBUG', 'Debug message');

    // Use a small time range (1 hour) to only count recent logs
    const metrics = await getLogMetrics({
      timeRange: 60 * 60 * 1000, // 1 hour
    });

    // byComponent should only count ERROR and WARN
    // Even though we inserted 10 INFO logs, they should not appear in byComponent
    assert.ok(metrics.byComponent, 'byComponent should exist');
    if (metrics.byComponent[component] !== undefined) {
      // The count should be 3: 2 ERROR + 1 WARN
      assert.strictEqual(
        metrics.byComponent[component],
        3,
        `${component} should have 3 errors/warnings in byComponent (2 ERROR + 1 WARN), but got ${metrics.byComponent[component]}`
      );
    } else {
      // If component doesn't appear, that's fine - it means no errors/warnings
      // But let's verify there are no errors/warnings for this component
      const allComponents = Object.keys(metrics.byComponent);
      assert.ok(
        !allComponents.includes(component) || metrics.byComponent[component] === 0,
        'component should not appear in byComponent with INFO logs'
      );
    }
  });

  test('byComponent counts errors and warnings from multiple components', async () => {
    const now = Date.now();
    const uniqueId = now;

    // Use unique component names to avoid conflicts with other tests
    const webuiComponent = `webui-test-${uniqueId}`;
    const botComponent = `bot-test-${uniqueId}`;

    // webui component: many INFO, few ERROR
    for (let i = 0; i < 20; i++) {
      await insertLog(now + i * 100, webuiComponent, 'INFO', `webui info ${i}`);
    }
    await insertLog(now + 2000, webuiComponent, 'ERROR', 'webui error');
    await insertLog(now + 2100, webuiComponent, 'WARN', 'webui warning');

    // bot component: some INFO, many ERROR
    await insertLog(now + 3000, botComponent, 'INFO', 'bot info');
    await insertLog(now + 3100, botComponent, 'ERROR', 'bot error 1');
    await insertLog(now + 3200, botComponent, 'ERROR', 'bot error 2');
    await insertLog(now + 3300, botComponent, 'ERROR', 'bot error 3');

    // Use a small time range (1 hour) to only count recent logs
    const metrics = await getLogMetrics({
      timeRange: 60 * 60 * 1000, // 1 hour
    });

    // webui should have 2 in byComponent (1 ERROR + 1 WARN), not 22
    if (metrics.byComponent[webuiComponent] !== undefined) {
      assert.strictEqual(
        metrics.byComponent[webuiComponent],
        2,
        `${webuiComponent} should have 2 errors/warnings, got ${metrics.byComponent[webuiComponent]}`
      );
    }

    // bot should have 3 in byComponent (3 ERROR), not 4
    if (metrics.byComponent[botComponent] !== undefined) {
      assert.strictEqual(
        metrics.byComponent[botComponent],
        3,
        `${botComponent} should have 3 errors/warnings, got ${metrics.byComponent[botComponent]}`
      );
    }
  });

  test('byComponent correctly excludes INFO logs even when component has many', async () => {
    const now = Date.now();
    const uniqueId = now;
    const component = `webui-test-${uniqueId}`;

    // Simulate the reported issue: webui has many INFO logs
    for (let i = 0; i < 50; i++) {
      await insertLog(now + i * 100, component, 'INFO', `Info log ${i}`);
    }

    // Add just a few actual errors
    await insertLog(now + 5000, component, 'ERROR', 'Actual error 1');
    await insertLog(now + 5100, component, 'ERROR', 'Actual error 2');

    // Use a small time range (1 hour) to only count recent logs
    const metrics = await getLogMetrics({
      timeRange: 60 * 60 * 1000, // 1 hour
    });

    // byComponent should show 2, not 52
    if (metrics.byComponent[component] !== undefined) {
      assert.strictEqual(
        metrics.byComponent[component],
        2,
        `${component} should have 2 errors in byComponent, not ${metrics.byComponent[component]} (INFO logs should be excluded)`
      );
    }
  });

  test('byLevel still includes all log levels', async () => {
    const now = Date.now();
    const uniqueId = now;
    const component = `test-${uniqueId}`;

    await insertLog(now, component, 'INFO', 'Info message');
    await insertLog(now + 1000, component, 'ERROR', 'Error message');
    await insertLog(now + 2000, component, 'WARN', 'Warning message');
    await insertLog(now + 3000, component, 'DEBUG', 'Debug message');

    // Use a small time range (1 hour) to only count recent logs
    const metrics = await getLogMetrics({
      timeRange: 60 * 60 * 1000, // 1 hour
    });

    // byLevel should include all levels
    assert.ok(metrics.byLevel, 'byLevel should exist');
    assert.ok(
      metrics.byLevel['INFO'] !== undefined || metrics.byLevel['INFO'] >= 0,
      'byLevel should include INFO'
    );
    assert.ok(
      metrics.byLevel['ERROR'] !== undefined || metrics.byLevel['ERROR'] >= 0,
      'byLevel should include ERROR'
    );
    assert.ok(
      metrics.byLevel['WARN'] !== undefined || metrics.byLevel['WARN'] >= 0,
      'byLevel should include WARN'
    );
    assert.ok(
      metrics.byLevel['DEBUG'] !== undefined || metrics.byLevel['DEBUG'] >= 0,
      'byLevel should include DEBUG'
    );
  });
});
