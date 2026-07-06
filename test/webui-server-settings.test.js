import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { initDatabase, setSetting } from '../src/utils/database.js';
import { isAdmin, refreshAdminCache } from '../src/utils/rate-limit.js';

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

after(async () => {
  // The test DB persists between runs - reset the keys these tests write.
  await setSetting('max_video_duration', '300');
  await setSetting('admin_user_ids', '[]');
  if (server) server.close();
  // Don't close database here - it's shared across parallel test files
});

async function putSetting(key, value) {
  const response = await fetch(`${baseUrl}/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

describe('settings route', () => {
  test('GET /api/settings exposes the known settings with type metadata', async () => {
    const response = await fetch(`${baseUrl}/api/settings`);
    assert.strictEqual(response.status, 200);
    const { settings } = await response.json();

    assert.strictEqual(settings.twitter_direct_url_fallback.type, 'boolean');
    assert.strictEqual(settings.max_video_duration.type, 'number');
    assert.strictEqual(settings.max_video_duration.min, 30);
    assert.strictEqual(settings.max_video_duration.max, 7200);
    assert.strictEqual(settings.admin_user_ids.type, 'list');
    assert.ok(Array.isArray(settings.admin_user_ids.envValues));
  });

  test('number setting accepts an in-range integer', async () => {
    const { response, data } = await putSetting('max_video_duration', 600);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.value, '600');
  });

  test('number setting rejects non-integers and out-of-range values', async () => {
    for (const bad of [12.5, 'abc', 10, 999999, true]) {
      const { response } = await putSetting('max_video_duration', bad);
      assert.strictEqual(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });

  test('list setting stores a deduplicated array of valid ids', async () => {
    const { response, data } = await putSetting('admin_user_ids', [
      '123456789012345678',
      '123456789012345678',
      ' 876543210987654321 ',
    ]);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(data.value), ['123456789012345678', '876543210987654321']);
  });

  test('list setting rejects non-arrays and malformed ids', async () => {
    for (const bad of ['123456789012345678', ['not-a-snowflake'], [123], [''], ['123']]) {
      const { response } = await putSetting('admin_user_ids', bad);
      assert.strictEqual(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });
});

describe('db-backed admin cache', () => {
  test('refreshAdminCache picks up webui-managed admins for isAdmin', async () => {
    const adminId = '111222333444555666';
    assert.strictEqual(isAdmin(adminId), false);

    await setSetting('admin_user_ids', JSON.stringify([adminId]));
    await refreshAdminCache();
    assert.strictEqual(isAdmin(adminId), true);

    await setSetting('admin_user_ids', '[]');
    await refreshAdminCache();
    assert.strictEqual(isAdmin(adminId), false);
  });

  test('refreshAdminCache keeps the previous cache on malformed data', async () => {
    const adminId = '999888777666555444';
    await setSetting('admin_user_ids', JSON.stringify([adminId]));
    await refreshAdminCache();
    assert.strictEqual(isAdmin(adminId), true);

    await setSetting('admin_user_ids', 'not json');
    await refreshAdminCache();
    assert.strictEqual(isAdmin(adminId), true, 'malformed data must not demote admins');

    await setSetting('admin_user_ids', '[]');
    await refreshAdminCache();
  });
});
