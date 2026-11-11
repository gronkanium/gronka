import { test, describe, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import { REST, Routes } from 'discord.js';
import { initDatabase, insertAlert, setSetting } from '../src/utils/database.js';
import { issueKey } from '../src/webui/issues.js';
import { commands } from '../src/register-commands.js';

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
  await setSetting('r2_soft_limit_gb', '9');
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
    assert.ok(!('max_video_duration' in settings), 'there is no length limit, only size');
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
    const { response, data } = await putSetting('r2_soft_limit_gb', 20);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.value, '20');
  });

  test('number setting rejects non-integers and out-of-range values', async () => {
    for (const bad of [12.5, 'abc', -1, 999999, true, '', null]) {
      const { response } = await putSetting('r2_soft_limit_gb', bad);
      assert.strictEqual(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });
});

describe('webui state', () => {
  const error = `states test error ${Date.now()}`;
  const cause = `states test cause ${Date.now()}`;
  const later = Date.now() + 86400e3;

  beforeAll(async () => {
    await insertAlert({
      severity: 'error',
      component: 'bot',
      title: 'command failed',
      message: `download failed - ${error}`,
      metadata: { command: 'download', error, cause },
    });
  });

  test('issue states keep muted and resolved entries and reject anything else', async () => {
    const good = {
      [issueKey(error)]: { state: 'muted', until: later },
      [issueKey(cause, 'cause')]: { state: 'resolved', at: 7 },
    };
    const { response, data } = await putSetting('webui_issue_states', good);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(data.value), good);
    for (const bad of [[], { a: { state: 'open' } }, { a: { state: 'muted', until: 'soon' } }]) {
      assert.strictEqual((await putSetting('webui_issue_states', bad)).response.status, 400);
    }
  });

  test('saving drops lapsed mutes and resolves whose alerts were all pruned', async () => {
    const live = { state: 'resolved', at: 7 };
    const states = {
      [issueKey(error)]: live,
      'pruned long ago': { state: 'resolved', at: 7 },
      'lapsed mute': { state: 'muted', until: 5 },
      'muted, nothing kept': { state: 'muted', until: later },
    };
    const { data } = await putSetting('webui_issue_states', states);
    assert.deepStrictEqual(JSON.parse(data.value), {
      [issueKey(error)]: live,
      'muted, nothing kept': { state: 'muted', until: later },
    });
  });

  test('stale states never fill the cap', async () => {
    const states = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`gone ${i}`, { state: 'resolved', at: 7 }])
    );
    states[issueKey(error)] = { state: 'resolved', at: 7 };
    const { response, data } = await putSetting('webui_issue_states', states);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(Object.keys(JSON.parse(data.value)), [issueKey(error)]);
  });
});

describe('command registration', () => {
  let put;
  afterEach(() => put?.mockRestore());
  const register = body =>
    fetch(`${baseUrl}/api/commands/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('registers the CLI command list and reports how many Discord stored', async () => {
    put = spyOn(REST.prototype, 'put').mockResolvedValue(commands);
    const response = await register({ confirm: true });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { count: commands.length });
    assert.strictEqual(put.mock.calls.length, 1);
    const [route, options] = put.mock.calls[0];
    assert.strictEqual(route, Routes.applicationCommands(process.env.CLIENT_ID));
    assert.strictEqual(options.body, commands);
  });

  test('needs an explicit confirm in a JSON body', async () => {
    put = spyOn(REST.prototype, 'put').mockResolvedValue(commands);
    assert.strictEqual((await register({})).status, 400);
    const form = await fetch(`${baseUrl}/api/commands/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'confirm=true',
    });
    assert.strictEqual(form.status, 400);
    assert.strictEqual(put.mock.calls.length, 0);
  });

  test('a Discord refusal comes back as the hint, never the raw error', async () => {
    put = spyOn(REST.prototype, 'put').mockRejectedValue(
      Object.assign(new Error('401: Unauthorized at /internal/path'), { status: 401 })
    );
    const response = await register({ confirm: true });
    assert.strictEqual(response.status, 502);
    assert.deepStrictEqual(await response.json(), { error: 'unauthorized: invalid bot token' });
  });
});
