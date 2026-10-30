import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import { initDatabase } from '../src/utils/database.js';

let server;
let baseUrl;

beforeAll(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  await new Promise(resolve => {
    server = createApp().listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

afterAll(() => {
  if (server) server.close();
});

describe('source checks route', () => {
  test('a POST without a JSON body is refused, so a cross-origin page cannot start a run', async () => {
    const bare = await fetch(`${baseUrl}/api/sources/checks/run`, { method: 'POST' });
    assert.strictEqual(bare.status, 415);
    const text = await fetch(`${baseUrl}/api/sources/checks/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.strictEqual(text.status, 415);
  });

  test('a JSON body naming an unknown example is a 404, not a run', async () => {
    const response = await fetch(`${baseUrl}/api/sources/checks/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/not-an-example' }),
    });
    assert.strictEqual(response.status, 404);
  });
});
