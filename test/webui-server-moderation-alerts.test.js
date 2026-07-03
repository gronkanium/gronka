import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  initDatabase,
  insertAlert,
  getAlertComponents,
  insertProcessedUrl,
  insertOrUpdateUser,
  getR2UserStats,
} from '../src/utils/database.js';
import { r2Config } from '../src/utils/config.js';

let app;
let server;
let baseUrl;

before(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  app = createApp();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
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
});
