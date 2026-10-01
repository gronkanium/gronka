import { test, expect, describe, beforeAll } from 'bun:test';
import crypto from 'node:crypto';
import * as accounts from '../../src/web/accounts.js';
import {
  base32Encode,
  currentStep,
  decryptSecret,
  encryptSecret,
  hotp,
  matchTotp,
} from '../../src/web/totp.js';
import { createHandler } from '../../src/web-server.js';
import { getPostgresConnection } from '../../src/utils/database/connection.js';

process.env.WEB_PEPPER ??= 'test-pepper-test-pepper-test-pepper-0123';
process.env.WEB_ENC_KEY ??= crypto.randomBytes(32).toString('hex');
const ORIGIN = 'https://web.gronka.dev';

beforeAll(() => accounts.ensureWebSchema());

const secretOf = async accountId => {
  const [row] = await getPostgresConnection()`
    SELECT coalesce(totp_secret, totp_pending) AS stored FROM web_accounts WHERE id = ${accountId}`;
  return decryptSecret(row.stored, accountId);
};

describe('totp', () => {
  test('RFC 6238 appendix B vectors (SHA-1, 8 digits)', () => {
    const seed = Buffer.from('12345678901234567890');
    const vectors = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [time, code] of vectors) {
      expect(hotp(seed, Math.floor(time / 30), 8)).toBe(code);
    }
  });

  test('base32 matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  test('accepts one step either side, never an old step', () => {
    const secret = crypto.randomBytes(20);
    const now = Date.now();
    const step = currentStep(now);
    expect(matchTotp(secret, hotp(secret, step), null, now)).toBe(step);
    expect(matchTotp(secret, hotp(secret, step - 1), null, now)).toBe(step - 1);
    expect(matchTotp(secret, hotp(secret, step + 1), null, now)).toBe(step + 1);
    expect(matchTotp(secret, hotp(secret, step - 2), null, now)).toBeNull();
    expect(matchTotp(secret, hotp(secret, step), step, now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', null, now)).toBeNull();
  });

  test('secrets are encrypted with the account id bound in', () => {
    const secret = crypto.randomBytes(20);
    const stored = encryptSecret(secret, 'ABCDE');
    expect(Buffer.from(stored, 'base64')[0]).toBe(1);
    expect(decryptSecret(stored, 'ABCDE').equals(secret)).toBe(true);
    expect(() => decryptSecret(stored, 'VWXYZ')).toThrow();
    const tampered = Buffer.from(stored, 'base64');
    tampered[20] ^= 1;
    expect(() => decryptSecret(tampered.toString('base64'), 'ABCDE')).toThrow();
  });
});

describe('second factor on an account', () => {
  test('enable, replay, throttle, the 100 ceiling and single-use recovery codes', async () => {
    const { id } = await accounts.createAccount();
    expect(await accounts.checkSecondFactor(id, '')).toBe('ok');
    const started = await accounts.startTotp(id);
    expect(started.uri).toStartWith(`otpauth://totp/gronka:${id}?secret=${started.secret}`);
    const secret = await secretOf(id);
    const step = currentStep();
    expect(await accounts.enableTotp(id, '000000')).toBeNull();
    const codes = await accounts.enableTotp(id, hotp(secret, step));
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(await accounts.startTotp(id)).toBeNull();

    expect(await accounts.checkSecondFactor(id, '')).toBe('required');
    expect(await accounts.checkSecondFactor(id, hotp(secret, step))).toBe('invalid');
    expect(await accounts.checkSecondFactor(id, hotp(secret, step + 1))).toBe('ok');

    expect(await accounts.checkSecondFactor(id, codes[0].toLowerCase())).toBe('ok');
    expect(await accounts.checkSecondFactor(id, codes[0])).toBe('invalid');
    expect((await accounts.getAccountSummary(id)).recoveryCodesLeft).toBe(9);

    for (let i = 0; i < 4; i++) await accounts.checkSecondFactor(id, 'nope');
    expect(await accounts.checkSecondFactor(id, codes[1])).toBe('locked');

    const sql = getPostgresConnection();
    await sql`UPDATE web_accounts SET totp_failures = 100, totp_locked_until = NULL WHERE id = ${id}`;
    expect(await accounts.checkSecondFactor(id, codes[1])).toBe('locked');
    await sql`UPDATE web_accounts SET totp_failures = 99 WHERE id = ${id}`;
    expect(await accounts.checkSecondFactor(id, codes[1])).toBe('ok');

    await accounts.disableTotp(id);
    expect(await accounts.checkSecondFactor(id, '')).toBe('ok');
    expect((await accounts.getAccountSummary(id)).recoveryCodesLeft).toBe(0);
    await accounts.deleteAccount(id);
  });

  test('parallel enables turn 2fa on once and hand out one set of codes', async () => {
    const { id } = await accounts.createAccount();
    await accounts.startTotp(id);
    const code = hotp(await secretOf(id), currentStep());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accounts.enableTotp(id, code))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await accounts.getAccountSummary(id)).recoveryCodesLeft).toBe(10);
    await accounts.deleteAccount(id);
  });

  test('regenerating with 2fa off hands out nothing', async () => {
    const { id } = await accounts.createAccount();
    expect(await accounts.regenerateRecoveryCodes(id)).toBeNull();
    expect((await accounts.getAccountSummary(id)).recoveryCodesLeft).toBe(0);
    await accounts.deleteAccount(id);
  });

  test('recovery codes are stored as keyed hashes, never in plaintext', async () => {
    const { id } = await accounts.createAccount();
    await accounts.startTotp(id);
    const codes = await accounts.enableTotp(id, hotp(await secretOf(id), currentStep()));
    const rows = await getPostgresConnection()`
      SELECT code_hash FROM web_recovery_codes WHERE account_id = ${id}`;
    expect(rows.every(row => /^[0-9a-f]{64}$/.test(row.code_hash))).toBe(true);
    expect(rows.some(row => row.code_hash.includes(codes[0].replace('-', '')))).toBe(false);
    await accounts.deleteAccount(id);
  });

  test('one recovery code presented twice at once lets exactly one login through', async () => {
    const { id } = await accounts.createAccount();
    await accounts.startTotp(id);
    const codes = await accounts.enableTotp(id, hotp(await secretOf(id), currentStep()));
    const results = await Promise.all([
      accounts.checkSecondFactor(id, codes[0]),
      accounts.checkSecondFactor(id, codes[0]),
    ]);
    expect(results.filter(r => r === 'ok')).toHaveLength(1);
    expect((await accounts.getAccountSummary(id)).recoveryCodesLeft).toBe(9);
    await accounts.deleteAccount(id);
  });
});

describe('routes', () => {
  const credentialId = crypto.randomBytes(16).toString('base64url');
  const webauthn = {
    generateRegistrationOptions: async options => ({ challenge: 'reg-challenge', ...options }),
    verifyRegistrationResponse: async ({ response, expectedChallenge, expectedRPID }) => ({
      verified: response?.ok === true && expectedChallenge === 'reg-challenge',
      registrationInfo: {
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        rpID: expectedRPID,
      },
    }),
    generateAuthenticationOptions: async () => ({ challenge: 'auth-challenge' }),
    verifyAuthenticationResponse: async ({ response, expectedChallenge, credential }) => ({
      verified:
        response?.ok === true &&
        expectedChallenge === 'auth-challenge' &&
        credential.id === credentialId,
      authenticationInfo: { newCounter: 5 },
    }),
  };
  const handle = createHandler({ verify: async token => token === 'ok', webauthn });
  const call = (method, path, { body, cookie, ip = '192.0.2.77' } = {}) =>
    handle(
      new Request(`http://web${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
          origin: ORIGIN,
          ...(cookie && { cookie }),
        },
        body: body && JSON.stringify(body),
      })
    );
  const cookieOf = res => res.headers.get('set-cookie').split(';')[0];
  const codeOf = async res => (await res.json()).error?.code;

  test('totp login flow and management', async () => {
    const signup = await call('POST', '/v1/account', { body: { turnstile: 'ok' } });
    const { id, number } = await signup.json();
    const cookie = cookieOf(signup);

    const setup = await call('POST', '/v1/totp/setup', { cookie });
    expect((await setup.json()).uri).toStartWith('otpauth://totp/');
    const secret = await secretOf(id);
    const step = currentStep();
    const bad = await call('POST', '/v1/totp/enable', { cookie, body: { code: '000000' } });
    expect(await codeOf(bad)).toBe('TOTP_INVALID');
    const enabled = await call('POST', '/v1/totp/enable', {
      cookie,
      body: { code: hotp(secret, step) },
    });
    const { recoveryCodes } = await enabled.json();
    expect(recoveryCodes).toHaveLength(10);
    expect((await call('POST', '/v1/totp/setup', { cookie })).status).toBe(409);

    const login = body =>
      call('POST', '/v1/session', { body: { number, turnstile: 'ok', ...body } });
    expect(await codeOf(await login({}))).toBe('TOTP_REQUIRED');
    expect(await codeOf(await login({ totp: '000000' }))).toBe('TOTP_INVALID');
    expect((await login({ totp: hotp(secret, step + 1) })).status).toBe(200);
    expect((await login({ totp: recoveryCodes[0] })).status).toBe(200);

    const regen = await call('POST', '/v1/totp/recovery', {
      cookie,
      body: { code: recoveryCodes[1] },
    });
    const fresh = (await regen.json()).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(await codeOf(await login({ totp: recoveryCodes[2] }))).toBe('TOTP_INVALID');

    expect(await codeOf(await call('DELETE', '/v1/totp', { cookie, body: {} }))).toBe(
      'TOTP_REQUIRED'
    );
    expect((await call('DELETE', '/v1/totp', { cookie, body: { code: fresh[0] } })).status).toBe(
      200
    );
    expect((await login({})).status).toBe(200);
    expect(await codeOf(await call('POST', '/v1/totp/recovery', { cookie, body: {} }))).toBe(
      'TOTP_OFF'
    );
    await accounts.deleteAccount(id);
  });

  test('rotating needs the second factor and ends every other session', async () => {
    const signup = await call('POST', '/v1/account', {
      body: { turnstile: 'ok' },
      ip: '192.0.2.79',
    });
    const { id, number } = await signup.json();
    const cookie = cookieOf(signup);
    await call('POST', '/v1/totp/setup', { cookie });
    const secret = await secretOf(id);
    const step = currentStep();
    await call('POST', '/v1/totp/enable', { cookie, body: { code: hotp(secret, step - 1) } });
    const other = await call('POST', '/v1/session', {
      body: { number, turnstile: 'ok', totp: hotp(secret, step) },
      ip: '192.0.2.79',
    });
    const otherCookie = cookieOf(other);

    expect(await codeOf(await call('POST', '/v1/account/rotate', { cookie, body: {} }))).toBe(
      'TOTP_REQUIRED'
    );
    expect(await codeOf(await call('DELETE', '/v1/account', { cookie, body: {} }))).toBe(
      'TOTP_REQUIRED'
    );
    expect(
      await codeOf(await call('POST', '/v1/passkeys/register/options', { cookie, body: {} }))
    ).toBe('TOTP_REQUIRED');
    const rotated = await call('POST', '/v1/account/rotate', {
      cookie,
      body: { code: hotp(secret, step + 1) },
    });
    expect(rotated.status).toBe(200);
    expect((await call('GET', '/v1/account', { cookie })).status).toBe(200);
    expect((await call('GET', '/v1/account', { cookie: otherCookie })).status).toBe(401);
    await accounts.deleteAccount(id);
  });

  test('parallel wrong codes cannot slip past the throttle', async () => {
    const { id } = await accounts.createAccount();
    await accounts.startTotp(id);
    await accounts.enableTotp(id, hotp(await secretOf(id), currentStep()));
    const results = await Promise.all(
      Array.from({ length: 12 }, () => accounts.checkSecondFactor(id, 'nope00'))
    );
    expect(results.filter(result => result === 'invalid').length).toBeLessThanOrEqual(5);
    await accounts.deleteAccount(id);
  });

  test('passkey register, login without a number, single-use challenge, remove', async () => {
    const signup = await call('POST', '/v1/account', {
      body: { turnstile: 'ok' },
      ip: '192.0.2.78',
    });
    const { id } = await signup.json();
    const cookie = cookieOf(signup);

    expect(
      await codeOf(await call('POST', '/v1/passkeys/register', { cookie, body: { response: {} } }))
    ).toBe('PASSKEY_INVALID');
    const options = await (await call('POST', '/v1/passkeys/register/options', { cookie })).json();
    expect(options).toMatchObject({ rpID: 'gronka.dev', userName: `GW ${id}` });
    expect(options.authenticatorSelection.residentKey).toBe('required');
    const added = await call('POST', '/v1/passkeys/register', {
      cookie,
      body: { response: { ok: true }, label: ' phone ' },
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ id: credentialId, label: 'phone' });

    expect(
      (await call('POST', '/v1/passkeys/login/options', { body: { turnstile: 'bad' } })).status
    ).toBe(403);
    const { challengeId } = await (
      await call('POST', '/v1/passkeys/login/options', { body: { turnstile: 'ok' } })
    ).json();
    const response = { id: credentialId, ok: true };
    const login = await call('POST', '/v1/passkeys/login', { body: { challengeId, response } });
    expect(login.status).toBe(200);
    expect((await login.json()).id).toBe(id);
    const passkeyCookie = cookieOf(login);
    const replay = await call('POST', '/v1/passkeys/login', { body: { challengeId, response } });
    expect(await codeOf(replay)).toBe('PASSKEY_INVALID');
    expect((await accounts.getPasskey(credentialId)).credential.counter).toBe(5);

    const summary = await (await call('GET', '/v1/account', { cookie: passkeyCookie })).json();
    expect(summary.passkeys.map(key => key.id)).toEqual([credentialId]);
    expect(summary.totp).toBe(false);
    expect(
      (await call('DELETE', `/v1/passkeys/${credentialId}`, { cookie: passkeyCookie })).status
    ).toBe(200);
    expect(
      (await call('DELETE', `/v1/passkeys/${credentialId}`, { cookie: passkeyCookie })).status
    ).toBe(404);
    await accounts.deleteAccount(id);
  });
});
