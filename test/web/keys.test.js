import { test, expect, describe, beforeAll } from 'bun:test';
import * as keys from '../../src/web/keys.js';
import { createHandler } from '../../src/web-server.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';

process.env.WEB_PEPPER ??= 'test-pepper-test-pepper-test-pepper-0123';

beforeAll(() => keys.ensureWebSchema());

describe('api keys', () => {
  test('a key verifies, a tampered one does not, and only its keyed hash is stored', async () => {
    const { id, key } = await keys.createApiKey();
    expect(key).toMatch(/^gk_[0-9a-z]{8}_[\w-]{43}[0-9a-f]{8}$/);
    const flipped = key.slice(0, 20) + (key[20] === 'a' ? 'b' : 'a') + key.slice(21);
    expect(keys.parseApiKey(flipped)).toBeNull();
    expect(await keys.verifyApiKey(key)).toBe(id.slice(3));
    expect(await keys.verifyApiKey(key.slice(0, -1) + 'x')).toBeNull();
    const sql = getPostgresConnection();
    const [row] = await sql`SELECT * FROM web_api_keys WHERE id = ${id.slice(3)}`;
    expect(Object.keys(row).sort()).toEqual(['id', 'secret_hash']);
    expect(row.secret_hash).not.toContain(keys.parseApiKey(key).secret);
    await keys.revokeApiKey(id.slice(3));
    expect(await keys.verifyApiKey(key)).toBeNull();
  });
});

describe('key routes', () => {
  const handle = createHandler({
    verify: async token => token === 'ok',
    download: async job => ({ lane: 'direct', files: [{ url: job.url }] }),
  });
  const call = (method, path, { body, auth } = {}) =>
    handle(
      new Request(`http://web${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.44',
          ...(auth && { authorization: auth }),
        },
        body: body && JSON.stringify(body),
      })
    );
  const download = auth =>
    call('POST', '/v1/download', { auth, body: { url: 'https://x.com/a/status/1' } });

  test('make a key, download with it, revoke it with itself', async () => {
    expect((await call('POST', '/v1/keys', { body: { turnstile: 'bad' } })).status).toBe(403);
    const made = await call('POST', '/v1/keys', { body: { turnstile: 'ok' } });
    expect(made.status).toBe(201);
    expect(made.headers.get('set-cookie')).toBeNull();
    const { key } = await made.json();

    expect(JSON.parse(await (await download(`Bearer ${key}`)).text()).lane).toBe('direct');
    expect((await download('Bearer gk_00000000_' + 'a'.repeat(51))).status).toBe(401);

    expect((await call('DELETE', '/v1/keys', { auth: 'Bearer nope' })).status).toBe(401);
    expect((await call('DELETE', '/v1/keys', { auth: `Bearer ${key}` })).status).toBe(200);
    expect((await download(`Bearer ${key}`)).status).toBe(401);
  });

  test('the account routes are gone', async () => {
    for (const path of ['/v1/account', '/v1/session', '/v1/totp/setup']) {
      expect((await call('POST', path, { body: { turnstile: 'ok' } })).status).toBe(404);
    }
  });
});
