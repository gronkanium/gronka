import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import {
  initDatabase,
  insertAlert,
  getAlertComponents,
  getAlertSummary,
  getAlerts,
  UNKNOWN_REASON,
} from '../src/utils/database.js';

let app;
let server;
let baseUrl;

beforeAll(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  app = createApp();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

afterAll(() => {
  if (server) server.close();
  // Don't close database here - it's shared across parallel test files
});

describe('alert components', () => {
  test('getAlertComponents returns distinct components including new ones', async () => {
    const component = `alerts-comp-test-${Date.now()}`;
    await insertAlert({
      severity: 'info',
      component,
      title: 'test alert',
      message: 'component listing test',
    });
    // Insert a duplicate to verify DISTINCT
    await insertAlert({
      severity: 'warning',
      component,
      title: 'test alert 2',
      message: 'component listing test 2',
    });

    const components = await getAlertComponents();
    assert.ok(Array.isArray(components));
    assert.strictEqual(
      components.filter(c => c === component).length,
      1,
      'component should appear exactly once'
    );
  });

  test('GET /api/alerts/components returns the components list', async () => {
    const component = `alerts-route-test-${Date.now()}`;
    await insertAlert({
      severity: 'error',
      component,
      title: 'route test alert',
      message: 'route test',
    });

    const response = await fetch(`${baseUrl}/api/alerts/components`);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.components));
    assert.ok(data.components.includes(component));
  });
});

describe('alert summary', () => {
  // Scoped to its own component because the test DB persists between runs
  const component = `alerts-summary-test-${Date.now()}`;

  beforeAll(async () => {
    const seed = [
      { severity: 'info', command: 'download', error: undefined },
      { severity: 'info', command: 'download', error: undefined },
      { severity: 'info', command: 'convert', error: undefined },
      { severity: 'error', command: 'download', error: 'unsupported platform' },
      { severity: 'error', command: 'download', error: 'unsupported platform' },
      { severity: 'error', command: 'convert', error: undefined },
    ];
    for (const { severity, command, error } of seed) {
      await insertAlert({
        severity,
        component,
        title: severity === 'error' ? 'command failed' : 'command success',
        message: `tester: ${command} ${severity === 'error' ? 'failed' : 'success'}`,
        metadata: { command, error },
      });
    }
  });

  test('aggregates severity, command, and reason over the whole window', async () => {
    const summary = await getAlertSummary({ component });

    assert.strictEqual(summary.total, 6);
    assert.strictEqual(summary.errors, 3);
    assert.strictEqual(summary.info, 3);

    const download = summary.byCommand.find(entry => entry.command === 'download');
    assert.strictEqual(download.total, 4);
    assert.strictEqual(download.errors, 2);

    const top = summary.byReason[0];
    assert.strictEqual(top.reason, 'unsupported platform');
    assert.strictEqual(top.count, 2);
    assert.deepStrictEqual(top.commands, ['download']);

    // Failures logged without an error string get their own bucket, not dropped
    const unknown = summary.byReason.find(entry => entry.reason === null);
    assert.strictEqual(unknown.count, 1);
  });

  test('command and reason filters narrow the alert list', async () => {
    const byCommand = await getAlerts({ component, command: 'convert' });
    assert.strictEqual(byCommand.length, 2);

    const byReason = await getAlerts({ component, reason: 'unsupported platform' });
    assert.strictEqual(byReason.length, 2);

    const unknown = await getAlerts({ component, reason: UNKNOWN_REASON });
    assert.strictEqual(unknown.length, 4, 'successes and reasonless failures both lack a reason');
  });

  test('GET /api/alerts/summary returns the aggregates', async () => {
    const response = await fetch(`${baseUrl}/api/alerts/summary?component=${component}`);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.errors, 3);
    assert.ok(data.byReason.some(entry => entry.reason === 'unsupported platform'));
  });

  test('GET /api/alerts/commands lists commands from metadata', async () => {
    const response = await fetch(`${baseUrl}/api/alerts/commands`);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(data.commands.includes('download'));
    assert.ok(data.commands.includes('convert'));
  });
});
