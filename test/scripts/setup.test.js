import { test, describe, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'fs';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const TOKEN = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
const CLIENT_ID = '123456789012345678';
const PASSWORD = 'hunter2hunter2';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gronka-setup-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(REPO, 'scripts/setup.js'), join(dir, 'scripts/setup.js'));
  copyFileSync(join(REPO, '.env.example'), join(dir, '.env.example'));
  copyFileSync(join(REPO, 'cookies.example.json'), join(dir, 'cookies.example.json'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args, stdin = '', extraEnv = {}) {
  const result = Bun.spawnSync([process.execPath, 'scripts/setup.js', ...args], {
    cwd: dir,
    env: { PATH: join(dir, 'no-tools'), HOME: dir, ...extraEnv },
    stdin: new TextEncoder().encode(stdin),
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

const env = () => readFileSync(join(dir, '.env'), 'utf8');

describe('setup', () => {
  test('--yes with every answer as a flag writes .env and never prints a secret', () => {
    const { code, out } = run([
      '--yes',
      `--token=${TOKEN}`,
      '--client-id',
      CLIENT_ID,
      `--db-password=${PASSWORD}`,
    ]);
    assert.strictEqual(code, 0, out);
    assert.match(env(), new RegExp(`^PROD_DISCORD_TOKEN=${TOKEN}$`, 'm'));
    assert.match(env(), new RegExp(`^PROD_CLIENT_ID=${CLIENT_ID}$`, 'm'));
    assert.match(env(), new RegExp(`^PROD_POSTGRES_PASSWORD=${PASSWORD}$`, 'm'));
    assert.strictEqual(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD));
    assert.ok(!out.includes('\x1b['), 'no colour codes when stdout is not a terminal');
  });

  test('SETUP_ environment variables answer like flags', () => {
    const { code, out } = run(['--yes'], '', {
      SETUP_TOKEN: TOKEN,
      SETUP_CLIENT_ID: CLIENT_ID,
      SETUP_DB_PASSWORD: PASSWORD,
    });
    assert.strictEqual(code, 0, out);
    assert.match(env(), new RegExp(`^PROD_DISCORD_TOKEN=${TOKEN}$`, 'm'));
    assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD));
  });

  test('--yes names every missing required flag and writes nothing', () => {
    const { code, out } = run(['--yes', `--token=${TOKEN}`]);
    assert.strictEqual(code, 1);
    assert.match(out, /--client-id, --db-password/);
    assert.ok(!existsSync(join(dir, '.env')));
  });

  test('--yes keeps the values an existing .env already has', () => {
    run(['--yes', `--token=${TOKEN}`, `--client-id=${CLIENT_ID}`, `--db-password=${PASSWORD}`]);
    const { code, out } = run(['--yes', '--admin-ids=987654321098765432']);
    assert.strictEqual(code, 0, out);
    assert.match(env(), new RegExp(`^PROD_DISCORD_TOKEN=${TOKEN}$`, 'm'));
    assert.match(env(), /^ADMIN_USER_IDS=987654321098765432$/m);
  });

  test('an invalid flag value fails instead of prompting', () => {
    const { code, out } = run([
      '--yes',
      '--token=nope',
      `--client-id=${CLIENT_ID}`,
      `--db-password=${PASSWORD}`,
    ]);
    assert.strictEqual(code, 1);
    assert.match(out, /--token/);
  });

  test('answers piped to the guided setup still work, secrets masked', () => {
    const answers = [TOKEN, CLIENT_ID, '', PASSWORD, 'n', '', 'n', ''].join('\n');
    const { code, out } = run([], answers);
    assert.strictEqual(code, 0, out);
    assert.match(env(), new RegExp(`^PROD_POSTGRES_PASSWORD=${PASSWORD}$`, 'm'));
    assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD));
  });

  test('unknown options exit 2', () => {
    assert.strictEqual(run(['--tokne=x']).code, 2);
    assert.strictEqual(run(['--json']).code, 2);
  });

  test('the seeded cookies.json holds no placeholder sessions', () => {
    run(['--yes', `--token=${TOKEN}`, `--client-id=${CLIENT_ID}`, `--db-password=${PASSWORD}`]);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')), {});
  });

  test('--check --json reports example placeholders as a problem', () => {
    copyFileSync(join(dir, 'cookies.example.json'), join(dir, 'cookies.json'));
    writeFileSync(join(dir, '.env'), '');
    const { code, out } = run(['--check', '--json']);
    assert.strictEqual(code, 1);
    const report = JSON.parse(out);
    assert.strictEqual(report.ready, false);
    assert.ok(report.problems.some(p => p.includes('instagram entry in cookies.json')));
    assert.ok(report.checks.some(c => c.section === 'Service cookies' && c.level === 'error'));
  });
});
