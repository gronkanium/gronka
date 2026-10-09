import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const ENV = {
  PATH: process.env.PATH,
  PROD_DISCORD_TOKEN: 'test-token',
  PROD_CLIENT_ID: 'test-client',
  PROD_POSTGRES_PASSWORD: 'test-password',
  WEB_DB_PASSWORD: 'test-password',
  WEB_PEPPER: 'test-pepper',
  WEB_STREAM_BASE: 'https://example.com',
  WEB_STREAM_KEY: 'test-stream-key',
  TURNSTILE_SECRET: 'test-turnstile-secret',
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  R2_PUBLIC_DOMAIN: 'example.com',
  CLOUDFLARE_TUNNEL_TOKEN: 'test-tunnel-token',
};

function config(files, env = {}) {
  const result = Bun.spawnSync(
    [
      'docker',
      'compose',
      '--project-name',
      'gronka-compose-test',
      '--env-file',
      '/dev/null',
      ...files.flatMap(file => ['-f', file]),
      'config',
      '--format',
      'json',
    ],
    { cwd: ROOT, env: { ...ENV, ...env } }
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

describe('compose networking', () => {
  test('the default stacks need no shared network', () => {
    const bot = config(['docker-compose.yml']);
    const web = config(['docker-compose.web.yml']);
    assert.ok(Object.values(bot.networks).every(network => !network.external));
    assert.ok(Object.values(web.networks).every(network => !network.external));
    assert.deepEqual(Object.keys(web.services['gronka-web'].networks).sort(), ['web', 'web-db']);
  });

  test('web receives a configured external geo proxy', () => {
    const proxy = 'http://proxy.example.com:8888';
    const web = config(['docker-compose.web.yml'], { GEO_PROXY_URL: proxy });
    assert.equal(web.services['gronka-web'].environment.GEO_PROXY_URL, proxy);
  });

  test('the optional web overlay shares only the existing VPN proxy network', () => {
    const env = { GEO_PROXY_NETWORK: 'test-geo-proxy', COMPOSE_PROFILES: 'vpn' };
    const bot = config(['docker-compose.yml'], env);
    const web = config(['docker-compose.web.yml', 'web/docker-compose.vpn.yml'], env);
    assert.equal(bot.networks['geo-proxy'].name, 'test-geo-proxy');
    assert.equal(bot.networks['geo-proxy'].internal, true);
    assert.ok(!bot.networks['geo-proxy'].external);
    assert.equal(web.networks['geo-proxy'].name, bot.networks['geo-proxy'].name);
    assert.equal(web.networks['geo-proxy'].external, true);
    assert.deepEqual(
      Object.entries(bot.services)
        .filter(([, service]) => Object.hasOwn(service.networks, 'geo-proxy'))
        .map(([name]) => name),
      ['vpn']
    );
    assert.deepEqual(Object.keys(web.services['gronka-web'].networks).sort(), [
      'geo-proxy',
      'web',
      'web-db',
    ]);
    assert.equal(web.services['gronka-web'].environment.GEO_PROXY_URL, 'http://vpn:8888');
    assert.ok(!web.services.vpn);
    assert.deepEqual(Object.keys(web.services.postgres.networks), ['web-db']);
  });
});
