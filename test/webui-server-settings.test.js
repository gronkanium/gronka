import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase, setSetting } from '../src/utils/database.js';

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

afterAll(async () => {
  // The test DB persists between runs - reset the keys these tests write.
  await setSetting('max_video_duration', '300');
  await setSetting('max_video_size_mb', '1024');
  await setSetting('twitter_delivery', 'hybrid');
  await setSetting('upload_ttl_tiers', '100:72,250:24,500:8,1024:2');
  await setSetting('disabled_services', '[]');
  await setSetting('webui_issue_states', '{}');
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
    assert.strictEqual(settings.max_video_duration.max, 21600);
    assert.strictEqual(settings.max_video_size_mb.type, 'number');
    assert.strictEqual(settings.max_video_size_mb.min, 50);
    assert.strictEqual(settings.max_video_size_mb.max, 2048);
    assert.strictEqual(settings.twitter_delivery.type, 'select');
    assert.deepStrictEqual(settings.twitter_delivery.options, [
      'hybrid',
      'always_url',
      'always_download',
    ]);
    assert.strictEqual(settings.twitter_delivery.value, 'hybrid');
    assert.strictEqual(settings.maintenance_mode.type, 'boolean');
    for (const gone of [
      'admin_user_ids',
      'rate_limit_cooldown',
      'moderation_enabled',
      'ntfy_topic',
    ]) {
      assert.ok(!(gone in settings), `${gone} no longer exists`);
    }
    assert.strictEqual(settings.upload_ttl_tiers.type, 'tiers');
    assert.strictEqual(settings.disabled_services.type, 'services');
    assert.ok(Array.isArray(settings.disabled_services.catalog));
    // catalog carries {id,label,category} for each source
    const sample = settings.disabled_services.catalog.find(s => s.id === 'xvideos');
    assert.ok(sample && sample.label === 'XVideos' && sample.category === 'adult');
  });

  test('services setting stores known ids sorted and drops unknown ones', async () => {
    const { response, data } = await putSetting('disabled_services', [
      'xvideos',
      'twitter',
      'not-a-real-service',
    ]);
    assert.strictEqual(response.status, 200);
    // unknown id dropped, remaining ids sorted
    assert.strictEqual(data.value, JSON.stringify(['twitter', 'xvideos']));

    const rejected = await putSetting('disabled_services', 'nope');
    assert.strictEqual(rejected.response.status, 400);

    await putSetting('disabled_services', []);
  });

  test('tiers setting normalizes (sorts ascending) and rejects malformed input', async () => {
    // Unsorted input is accepted and stored ascending by size ceiling.
    const { response, data } = await putSetting('upload_ttl_tiers', '500:8,100:72,250:24');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.value, '100:72,250:24,500:8');

    for (const bad of ['', 'garbage', '100:0', '0:5', '100', ['100:72'], 42, 'abc:def']) {
      const { response: badResponse } = await putSetting('upload_ttl_tiers', bad);
      assert.strictEqual(badResponse.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });

  test('select setting accepts listed options and rejects everything else', async () => {
    const { response, data } = await putSetting('twitter_delivery', 'always_url');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.value, 'always_url');

    for (const bad of ['sometimes', '', 42, true]) {
      const { response: badResponse } = await putSetting('twitter_delivery', bad);
      assert.strictEqual(badResponse.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
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
});

describe('webui state', () => {
  test('issue states keep muted and resolved entries and reject anything else', async () => {
    const good = { a: { state: 'muted', until: 5 }, b: { state: 'resolved', at: 7 } };
    const { response, data } = await putSetting('webui_issue_states', good);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(data.value), good);
    for (const bad of [[], { a: { state: 'open' } }, { a: { state: 'muted', until: 'soon' } }]) {
      assert.strictEqual((await putSetting('webui_issue_states', bad)).response.status, 400);
    }
  });
});
