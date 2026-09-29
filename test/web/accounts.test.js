import { test, expect, describe, beforeAll } from 'bun:test';
import * as accounts from '../../src/web/accounts.js';
import { createHandler } from '../../src/web-server.js';

process.env.WEB_PEPPER ??= 'test-pepper-test-pepper-test-pepper-0123';
const ORIGIN = 'https://web.gronka.dev';

beforeAll(() => accounts.ensureWebSchema());

describe('account numbers', () => {
  test('parsing forgives case, spaces, dashes and look-alike letters', () => {
    const id = '7K3P9';
    const secret = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
    const number = accounts.formatAccountNumber(id, secret);
    expect(number).toBe('GW 7K3P9 ABCDE FGHJK MNPQR STVWX YZ012 3');
    expect(accounts.parseAccountNumber('GW-7K3P9-ABCDE-FGHJK-MNPQR-STVWX-YZ012-3')).toEqual(
      accounts.parseAccountNumber(number)
    );
    expect(accounts.parseAccountNumber(number)).toEqual({ id, secret });
    expect(accounts.parseAccountNumber(` gw 7k3p9 abcde fghjk mnpqr stvwx yzo12 3`)).toEqual({
      id,
      secret,
    });
    expect(accounts.parseAccountNumber('GW-7K3P9-ABCDE')).toBeNull();
    expect(accounts.parseAccountNumber('GW-7K3PU-ABCDEFGHJKMNPQRSTVWXYZ0123')).toBeNull();
  });

  test('parallel key requests cannot pass the 10-key quota', async () => {
    const { id } = await accounts.createAccount();
    for (let i = 0; i < 9; i++) await accounts.createApiKey(id);
    const made = await Promise.all(Array.from({ length: 5 }, () => accounts.createApiKey(id)));
    expect(made.filter(Boolean)).toHaveLength(1);
    expect((await accounts.getAccountSummary(id)).keys).toHaveLength(10);
    await accounts.deleteAccount(id);
  });

  test('create, verify, and rotate: the old number dies at once', async () => {
    const { id, number } = await accounts.createAccount();
    expect(await accounts.verifyAccountNumber(number)).toBe(id);
    expect(await accounts.verifyAccountNumber(number.toLowerCase())).toBe(id);
    const wrong = number.slice(0, -1) + (number.endsWith('0') ? '1' : '0');
    expect(await accounts.verifyAccountNumber(wrong)).toBeNull();
    const rotated = await accounts.rotateAccountNumber(id);
    expect(await accounts.verifyAccountNumber(number)).toBeNull();
    expect(await accounts.verifyAccountNumber(rotated)).toBe(id);
    await accounts.deleteAccount(id);
    expect(await accounts.verifyAccountNumber(rotated)).toBeNull();
  });

  test('nothing secret is stored in plaintext', async () => {
    const { id, number } = await accounts.createAccount();
    const { key } = await accounts.createApiKey(id);
    const { getPostgresConnection } = await import('../../src/utils/database/connection.js');
    const sql = getPostgresConnection();
    const [row] = await sql`SELECT secret_hash FROM web_accounts WHERE id = ${id}`;
    const secret = accounts.parseAccountNumber(number).secret;
    expect(row.secret_hash.startsWith('$argon2id$')).toBe(true);
    expect(row.secret_hash).not.toContain(secret);
    const [keyRow] = await sql`SELECT secret_hash FROM web_api_keys WHERE account_id = ${id}`;
    expect(keyRow.secret_hash).not.toContain(accounts.parseApiKey(key).secret);
    await accounts.deleteAccount(id);
  });
});

describe('api keys and sessions', () => {
  test('keys verify, are capped at 10, and a revoked key stops working even when cached', async () => {
    const { id } = await accounts.createAccount();
    const first = await accounts.createApiKey(id, '  my script  ');
    expect(first.key).toMatch(/^gk_[0-9a-z]{8}_[\w-]{43}[0-9a-f]{8}$/);
    const flipped =
      first.key.slice(0, 20) + (first.key[20] === 'a' ? 'b' : 'a') + first.key.slice(21);
    expect(accounts.parseApiKey(flipped)).toBeNull();
    expect((await accounts.verifyApiKey(first.key)).accountId).toBe(id);
    expect(await accounts.verifyApiKey(first.key.slice(0, -1) + 'x')).toBeNull();
    const summary = await accounts.getAccountSummary(id);
    expect(summary.keys[0]).toMatchObject({ id: first.id, label: 'my script' });
    expect(summary.keys[0].lastUsedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < 10; i++) await accounts.createApiKey(id);
    expect(await accounts.createApiKey(id)).toBeNull();
    expect(await accounts.revokeApiKey(id, first.id)).toBe(true);
    expect(await accounts.verifyApiKey(first.key)).toBeNull();
    await accounts.deleteAccount(id);
  });

  test('sessions resolve until deleted, and die with the account', async () => {
    const { id } = await accounts.createAccount();
    const token = await accounts.createSession(id);
    expect(await accounts.getSessionAccount(token)).toBe(id);
    const { getPostgresConnection } = await import('../../src/utils/database/connection.js');
    const sql = getPostgresConnection();
    await sql`UPDATE web_sessions SET expires_at = now() - interval '1 second' WHERE account_id = ${id}`;
    expect(await accounts.getSessionAccount(token)).toBeNull();
    const fresh = await accounts.createSession(id);
    await sql`UPDATE web_sessions SET absolute_at = now() + interval '1 hour' WHERE account_id = ${id}`;
    expect(await accounts.getSessionAccount(fresh)).toBe(id);
    const [{ capped }] = await sql`
      SELECT bool_and(expires_at <= absolute_at) AS capped FROM web_sessions WHERE account_id = ${id}`;
    expect(capped).toBe(true);
    await accounts.deleteSession(fresh);
    expect(await accounts.getSessionAccount(fresh)).toBeNull();
    await accounts.deleteSession(token);
    expect(await accounts.getSessionAccount(token)).toBeNull();
    const second = await accounts.createSession(id);
    await accounts.deleteAccount(id);
    expect(await accounts.getSessionAccount(second)).toBeNull();
  });
});

describe('account routes', () => {
  const handle = createHandler({
    verify: async token => token === 'ok',
    download: async job => ({ lane: 'direct', files: [{ url: job.url }] }),
  });
  const call = (method, path, { body, cookie, origin = ORIGIN, auth } = {}) =>
    handle(
      new Request(`http://web${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.44',
          ...(origin && { origin }),
          ...(cookie && { cookie }),
          ...(auth && { authorization: auth }),
        },
        body: body && JSON.stringify(body),
      })
    );
  const cookieOf = res => res.headers.get('set-cookie').split(';')[0];

  test('signup to key to keyed download, with CSRF and logout', async () => {
    expect((await call('POST', '/v1/account', { body: { turnstile: 'bad' } })).status).toBe(403);
    const signup = await call('POST', '/v1/account', { body: { turnstile: 'ok' } });
    expect(signup.status).toBe(201);
    expect(signup.headers.get('set-cookie')).toMatch(
      /^__Host-gw_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict/
    );
    const { number } = await signup.json();
    const cookie = cookieOf(signup);

    expect((await call('POST', '/v1/keys', { cookie, origin: null })).status).toBe(403);
    expect(
      (await call('POST', '/v1/keys', { cookie, origin: 'https://evil.example' })).status
    ).toBe(403);
    const created = await (
      await call('POST', '/v1/keys', { cookie, body: { label: 'cli' } })
    ).json();

    const keyed = await call('POST', '/v1/download', {
      origin: null,
      auth: `Bearer ${created.key}`,
      body: { url: 'https://x.com/a/status/1' },
    });
    expect(JSON.parse(await keyed.text()).lane).toBe('direct');
    const badKey = await call('POST', '/v1/download', {
      origin: null,
      auth: 'Bearer gk_00000000_' + 'a'.repeat(51),
      body: { url: 'https://x.com/a/status/1' },
    });
    expect(badKey.status).toBe(401);

    const login = await call('POST', '/v1/session', { body: { number, turnstile: 'ok' } });
    expect(login.status).toBe(200);
    expect(
      (await call('POST', '/v1/session', { body: { number: number + 'X', turnstile: 'ok' } }))
        .status
    ).toBe(401);

    const summary = await (await call('GET', '/v1/account', { cookie })).json();
    expect(summary.keys.map(key => key.id)).toEqual([created.id]);

    await call('DELETE', '/v1/session', { cookie });
    expect((await call('GET', '/v1/account', { cookie })).status).toBe(401);
    await call('DELETE', '/v1/account', { cookie: cookieOf(login) });
    expect(await accounts.verifyAccountNumber(number)).toBeNull();
  });
});
