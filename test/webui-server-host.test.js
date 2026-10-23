import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import http from 'node:http';
import { initDatabase } from '../src/utils/database.js';

let server;
let port;

const statusFor = host =>
  new Promise((resolve, reject) => {
    http
      .get({ port, path: '/api/settings', headers: { host } }, res => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });

beforeAll(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  await new Promise(resolve => {
    server = createApp().listen(0, resolve);
  });
  port = server.address().port;
});

afterAll(() => server?.close());

describe('webui host guard', () => {
  test('answers to addresses and localhost', async () => {
    for (const host of ['127.0.0.1:3001', '192.168.0.212:3001', '[::1]:3001', 'localhost:3001']) {
      assert.strictEqual(await statusFor(host), 200, host);
    }
  });

  test('refuses a rebound hostname', async () => {
    assert.strictEqual(await statusFor('evil.example:3001'), 421);
  });

  test('answers to hosts named in WEBUI_ALLOWED_HOSTS', async () => {
    process.env.WEBUI_ALLOWED_HOSTS = 'gronka.lan,other.lan';
    try {
      assert.strictEqual(await statusFor('gronka.lan:3001'), 200);
    } finally {
      delete process.env.WEBUI_ALLOWED_HOSTS;
    }
  });
});
