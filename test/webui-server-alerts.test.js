import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { variantFilter } from '../src/webui/issues.js';
import {
  initDatabase,
  insertAlert,
  getAlertSummary,
  getAlerts,
  UNKNOWN_REASON,
  REASON_LIMIT,
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

test('GET /api/alerts/components is gone', async () => {
  assert.strictEqual((await fetch(`${baseUrl}/api/alerts/components`)).status, 404);
});

describe('alert paging', () => {
  test('limit and offset are clamped, never passed through raw', async () => {
    const bad = await (await fetch(`${baseUrl}/api/alerts?limit=abc&offset=-5`)).json();
    assert.strictEqual(bad.limit, 100);
    assert.strictEqual(bad.offset, 0);
    const huge = await (await fetch(`${baseUrl}/api/alerts?limit=99999999`)).json();
    assert.strictEqual(huge.limit, 1000);
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

describe('issue groups', () => {
  test('the summary lists up to REASON_LIMIT reasons whatever the query asks for', async () => {
    const component = `alerts-limit-test-${Date.now()}`;
    await Promise.all(
      Array.from({ length: REASON_LIMIT + 5 }, (_, i) =>
        insertAlert({
          severity: 'error',
          component,
          title: 'command failed',
          message: 'download failed',
          metadata: { command: 'download', error: `limit reason ${i}` },
        })
      )
    );
    for (const query of ['', '&reasonLimit=300', '&reasonLimit=5']) {
      const data = await (
        await fetch(`${baseUrl}/api/alerts/summary?component=${component}${query}`)
      ).json();
      assert.strictEqual(data.byReason.length, REASON_LIMIT, `query "${query}"`);
    }
  });

  test("an issue's events are fetched by a filter /api/alerts applies, for both groupings", async () => {
    const component = `alerts-variant-test-${Date.now()}`;
    for (const n of [1, 2]) {
      await insertAlert({
        severity: 'error',
        component,
        title: 'command failed',
        message: `download failed - error ${n}`,
        metadata: { command: 'download', error: `error ${n}`, cause: `cause ${n}` },
      });
    }
    for (const [by, value] of [
      ['error', 'error 1'],
      ['cause', 'cause 1'],
    ]) {
      const query = new URLSearchParams({ component, [variantFilter(by)]: value });
      const data = await (await fetch(`${baseUrl}/api/alerts?${query}`)).json();
      assert.strictEqual(data.total, 1, `grouped by ${by}`);
    }
  });

  test('warnings group into issues and the severity filter picks them out', async () => {
    const component = `alerts-warning-test-${Date.now()}`;
    await insertAlert({
      severity: 'warning',
      component,
      title: 'R2 cleanup: deletions failed',
      message: '2 expired object(s) could not be deleted',
      metadata: { error: 'cleanup could not delete expired files', count: 2 },
    });
    await insertAlert({
      severity: 'error',
      component,
      title: 'command failed',
      message: 'download failed - boom',
      metadata: { command: 'download', error: 'boom' },
    });

    const all = await (await fetch(`${baseUrl}/api/alerts/summary?component=${component}`)).json();
    assert.deepStrictEqual(all.byReason.map(r => r.reason).sort(), [
      'boom',
      'cleanup could not delete expired files',
    ]);
    const warnings = await (
      await fetch(`${baseUrl}/api/alerts/summary?component=${component}&severity=warning`)
    ).json();
    assert.deepStrictEqual(
      warnings.byReason.map(r => r.reason),
      ['cleanup could not delete expired files']
    );
  });
});
