import { describe, test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isR2Configured } from '../../src/utils/r2-storage.js';

const ROOT = path.resolve(import.meta.dir, '../..');
const PROD_R2 = {
  R2_ACCOUNT_ID: 'prod-account',
  R2_ACCESS_KEY_ID: 'prod-key',
  R2_SECRET_ACCESS_KEY: 'prod-secret',
  R2_BUCKET_NAME: 'prod-bucket',
  R2_PUBLIC_DOMAIN: 'cdn.example.com',
  R2_CLEANUP_ENABLED: 'true',
};
let dir;

// A fake `bun` on PATH stands in for the bot and prints the R2 config it would run with.
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gronka-bot-start-'));
  const env = Object.entries(PROD_R2).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(path.join(dir, '.env'), `${env.join('\n')}\n`);
  await fs.writeFile(
    path.join(dir, 'print-r2.js'),
    `const { r2Config } = await import(${JSON.stringify(path.join(ROOT, 'src/utils/config.js'))});\n` +
      'console.log(JSON.stringify(r2Config));\n'
  );
  await fs.writeFile(
    path.join(dir, 'bun'),
    `#!/bin/sh\ncd "${dir}" && exec "${process.execPath}" print-r2.js\n`,
    { mode: 0o755 }
  );
});

afterAll(() => fs.rm(dir, { recursive: true, force: true }));

function botR2Config(prefix, env = {}) {
  const result = Bun.spawnSync(
    [process.execPath, path.join(ROOT, 'scripts/bot-start.js'), prefix],
    {
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        [`${prefix}_DISCORD_TOKEN`]: 'token',
        [`${prefix}_CLIENT_ID`]: 'client',
        [`${prefix}_POSTGRES_DB`]: 'gronka_scratch',
        ...env,
      },
    }
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1));
}

describe('bot-start', () => {
  test('the test bot never uses the plain R2 keys from .env', () => {
    const r2 = botR2Config('TEST');
    assert.equal(isR2Configured(r2), false);
    assert.equal(r2.publicDomain, '');
    assert.equal(r2.cleanupEnabled, false);
  });

  test('the test bot uses its own TEST_R2 keys', () => {
    const r2 = botR2Config('TEST', {
      TEST_R2_ACCOUNT_ID: 'test-account',
      TEST_R2_ACCESS_KEY_ID: 'test-key',
      TEST_R2_SECRET_ACCESS_KEY: 'test-secret',
      TEST_R2_BUCKET_NAME: 'test-bucket',
    });
    assert.equal(isR2Configured(r2), true);
    assert.equal(r2.bucketName, 'test-bucket');
    assert.equal(r2.cleanupEnabled, false);
  });

  test('the prod bot keeps the plain R2 keys', () => {
    const r2 = botR2Config('PROD');
    assert.equal(isR2Configured(r2), true);
    assert.equal(r2.bucketName, 'prod-bucket');
  });
});
