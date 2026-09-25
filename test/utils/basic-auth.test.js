import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import { basicAuth, isLanAddress } from '../../src/utils/basic-auth.js';
import { serverConfig } from '../../src/utils/config.js';
import { getSetting, setSetting } from '../../src/utils/database.js';

const saved = { u: serverConfig.statsUsername, p: serverConfig.statsPassword };
const savedMode = await getSetting('webui_login', 'everyone');
afterAll(async () => {
  serverConfig.statsUsername = saved.u;
  serverConfig.statsPassword = saved.p;
  await setSetting('webui_login', savedMode);
});

async function run(remoteAddress, authorization, cookie) {
  let status = null;
  let passed = false;
  const cookies = [];
  const res = {
    set() {},
    append(name, value) {
      cookies.push(value);
    },
    status(code) {
      status = code;
      return { json() {} };
    },
  };
  await basicAuth({ socket: { remoteAddress }, headers: { authorization, cookie } }, res, () => {
    passed = true;
  });
  return { result: passed ? 'next' : status, cookie: cookies[0]?.split(';')[0] };
}

const basic = creds => `Basic ${Buffer.from(creds).toString('base64')}`;
const withCreds = async mode => {
  serverConfig.statsUsername = 'admin';
  serverConfig.statsPassword = 'secret';
  await setSetting('webui_login', mode);
};

test('basicAuth - loopback always passes', async () => {
  await withCreds('everyone');
  assert.strictEqual((await run('127.0.0.1')).result, 'next');
  assert.strictEqual((await run('::ffff:127.0.0.1')).result, 'next');
});

test('basicAuth - everyone needs the right credentials', async () => {
  await withCreds('everyone');
  assert.strictEqual((await run('192.168.0.5')).result, 401);
  assert.strictEqual((await run('192.168.0.5', basic('admin:wrong'))).result, 401);
  assert.strictEqual((await run('192.168.0.5', basic('admin:secret'))).result, 'next');
});

test('basicAuth - remote is refused when no credentials are configured', async () => {
  await withCreds('everyone');
  serverConfig.statsUsername = null;
  serverConfig.statsPassword = null;
  assert.strictEqual((await run('192.168.0.5', basic('admin:secret'))).result, 403);
});

test('basicAuth - skip_on_lan lets the local network in and still asks everyone else', async () => {
  await withCreds('skip_on_lan');
  assert.strictEqual((await run('192.168.0.5')).result, 'next');
  assert.strictEqual((await run('::ffff:10.1.2.3')).result, 'next');
  assert.strictEqual((await run('8.8.8.8')).result, 401);
});

test('basicAuth - new_devices_only remembers a device until the password changes', async () => {
  await withCreds('new_devices_only');
  const login = await run('192.168.0.5', basic('admin:secret'));
  assert.strictEqual(login.result, 'next');
  assert.ok(login.cookie);
  assert.strictEqual((await run('192.168.0.5', undefined, login.cookie)).result, 'next');
  assert.strictEqual((await run('192.168.0.5', undefined, 'gronka_device=forged.sig')).result, 401);
  serverConfig.statsPassword = 'rotated';
  assert.strictEqual((await run('192.168.0.5', undefined, login.cookie)).result, 401);
});

test('isLanAddress covers private ranges only', () => {
  for (const address of ['10.0.0.1', '192.168.1.1', '172.20.0.1', 'fd00::1', 'fe80::1']) {
    assert.strictEqual(isLanAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) {
    assert.strictEqual(isLanAddress(address), false, address);
  }
});
