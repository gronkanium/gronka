import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';

describe('webui-server rate limiting', () => {
  let server;

  beforeAll(async () => {
    const { createApp } = await import('../src/webui-server/app.js');
    await new Promise(resolve => {
      server = createApp().listen(0, resolve);
    });
  });

  afterAll(() => server?.close());

  test('api routes pass through the rate limiter', async () => {
    const response = await fetch(`http://localhost:${server.address().port}/api/nonexistent-route`);
    assert.strictEqual(response.status, 404);
    const hasRateLimitHeader = [...response.headers.keys()].some(name =>
      name.toLowerCase().startsWith('ratelimit')
    );
    assert.ok(hasRateLimitHeader, 'expected RateLimit headers on /api responses');
  });
});
