import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import { basicAuth } from '../../src/utils/basic-auth.js';
import { serverConfig } from '../../src/utils/config.js';

const saved = { u: serverConfig.statsUsername, p: serverConfig.statsPassword };
afterAll(() => {
  serverConfig.statsUsername = saved.u;
  serverConfig.statsPassword = saved.p;
});

function run(remoteAddress, authorization) {
  let status = null;
  let passed = false;
  const res = {
    set() {},
    status(code) {
      status = code;
      return { json() {} };
    },
  };
  basicAuth({ socket: { remoteAddress }, headers: { authorization } }, res, () => {
    passed = true;
  });
  return passed ? 'next' : status;
}

const basic = creds => `Basic ${Buffer.from(creds).toString('base64')}`;

test('basicAuth - loopback always passes', () => {
  serverConfig.statsUsername = 'admin';
  serverConfig.statsPassword = 'secret';
  assert.strictEqual(run('127.0.0.1'), 'next');
  assert.strictEqual(run('::ffff:127.0.0.1'), 'next');
});

test('basicAuth - remote needs the right credentials', () => {
  serverConfig.statsUsername = 'admin';
  serverConfig.statsPassword = 'secret';
  assert.strictEqual(run('172.19.0.1'), 401);
  assert.strictEqual(run('172.19.0.1', basic('admin:wrong')), 401);
  assert.strictEqual(run('172.19.0.1', basic('admin:secret')), 'next');
});

test('basicAuth - remote is refused when no credentials are configured', () => {
  serverConfig.statsUsername = null;
  serverConfig.statsPassword = null;
  assert.strictEqual(run('192.168.0.5', basic('admin:secret')), 403);
});
