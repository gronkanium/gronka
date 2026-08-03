import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import {
  initDatabase,
  insertAlert,
  getAlertComponents,
  getAlertSummary,
  getAlerts,
  UNKNOWN_REASON,
  insertProcessedUrl,
  insertOrUpdateUser,
  getR2UserStats,
  getUserR2Media,
  getUserR2MediaCount,
  markProcessedUrlsR2Expired,
} from '../src/utils/database.js';
import { r2Config } from '../src/utils/config.js';

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
        metadata: { command, username: 'tester', error },
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

describe('r2 user stats', () => {
  test('getR2UserStats aggregates count and size per user', async () => {
    const uniqueId = Date.now();
    const userId = `r2stats-user-${uniqueId}`;
    const username = `r2stats-name-${uniqueId}`;
    const r2Prefix = `https://${r2Config.publicDomain}/`;

    await insertOrUpdateUser(userId, username, uniqueId);
    await insertProcessedUrl(
      `r2stats-hash-a-${uniqueId}`,
      'filehash-a',
      'gif',
      'gif',
      `${r2Prefix}test/a-${uniqueId}.gif`,
      uniqueId,
      userId,
      1000
    );
    await insertProcessedUrl(
      `r2stats-hash-b-${uniqueId}`,
      'filehash-b',
      'video',
      'mp4',
      `${r2Prefix}test/b-${uniqueId}.mp4`,
      uniqueId,
      userId,
      2500
    );
    // Non-R2 URL must not be counted
    await insertProcessedUrl(
      `r2stats-hash-c-${uniqueId}`,
      'filehash-c',
      'gif',
      'gif',
      `https://example.com/not-r2-${uniqueId}.gif`,
      uniqueId,
      userId,
      9999
    );

    const stats = await getR2UserStats();
    const row = stats.find(s => s.user_id === userId);
    assert.ok(row, 'expected a stats row for the seeded user');
    assert.strictEqual(row.username, username);
    assert.strictEqual(row.file_count, 2);
    assert.strictEqual(row.total_size, 3500);
  });

  test('GET /api/moderation/r2-users returns per-user stats', async () => {
    const uniqueId = Date.now() + 1;
    const userId = `r2route-user-${uniqueId}`;
    const r2Prefix = `https://${r2Config.publicDomain}/`;

    await insertOrUpdateUser(userId, `r2route-name-${uniqueId}`, uniqueId);
    await insertProcessedUrl(
      `r2route-hash-${uniqueId}`,
      'filehash-r',
      'image',
      'png',
      `${r2Prefix}test/r-${uniqueId}.png`,
      uniqueId,
      userId,
      500
    );

    const response = await fetch(`${baseUrl}/api/moderation/r2-users`);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.users));
    const row = data.users.find(u => u.user_id === userId);
    assert.ok(row, 'expected the seeded user in the response');
    assert.strictEqual(row.file_count, 1);
    assert.strictEqual(row.total_size, 500);
  });

  test('stats are sorted by total size descending', async () => {
    const stats = await getR2UserStats();
    for (let i = 1; i < stats.length; i++) {
      assert.ok(
        stats[i - 1].total_size >= stats[i].total_size,
        'expected descending total_size order'
      );
    }
  });

  test('rows marked R2-expired are excluded from stats and user media lists', async () => {
    const uniqueId = Date.now() + 2;
    const userId = `r2expired-user-${uniqueId}`;
    const username = `r2expired-name-${uniqueId}`;
    const r2Prefix = `https://${r2Config.publicDomain}/`;
    const urlHash = `r2expired-hash-${uniqueId}`;

    await insertOrUpdateUser(userId, username, uniqueId);
    await insertProcessedUrl(
      urlHash,
      'filehash-expired',
      'gif',
      'gif',
      `${r2Prefix}test/expired-${uniqueId}.gif`,
      uniqueId,
      userId,
      4000
    );

    // Sanity check: shows up before it's marked expired
    const before = await getUserR2Media(userId);
    assert.ok(
      before.some(m => m.url_hash === urlHash),
      'expected the row to appear before being marked expired'
    );
    assert.strictEqual(await getUserR2MediaCount(userId), before.length);

    await markProcessedUrlsR2Expired([urlHash]);

    const after = await getUserR2Media(userId);
    assert.ok(
      !after.some(m => m.url_hash === urlHash),
      'expired row should no longer appear in the user R2 media list'
    );
    assert.strictEqual(await getUserR2MediaCount(userId), after.length);

    const stats = await getR2UserStats();
    const row = stats.find(s => s.user_id === userId);
    assert.ok(!row, 'user with only an expired R2 row should not appear in aggregate stats');
  });
});
