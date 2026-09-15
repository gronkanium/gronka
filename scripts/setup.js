#!/usr/bin/env bun

/**
 * First-run setup for a fresh clone.
 *
 * Usage:
 *   bun run setup            interactive wizard: asks only what it cannot work out itself
 *   bun run setup --check    diagnose an existing install and change nothing
 *   bun run setup --repair   create the missing files a working install needs, no questions
 *
 * Options:
 *   --check, -c     read-only diagnosis; exits non-zero if anything is broken
 *   --repair        non-interactive: run every fix that needs no input from you
 *   --yes, -y       accept every default (only asks for values with no safe default)
 */

import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'fs';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (...names) => names.some(n => argv.includes(n));
const CHECK = flag('--check', '-c');
const REPAIR = flag('--repair');
const ASSUME_YES = flag('--yes', '-y');

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

const RULE = '━'.repeat(64);
const say = (...a) => console.log(...a);
const heading = t => say(`\n${c.bold(t)}\n${c.dim(RULE)}`);
const ok = m => say(`  ${c.green('✓')} ${m}`);
const warn = m => say(`  ${c.yellow('!')} ${m}`);
const bad = m => say(`  ${c.red('✗')} ${m}`);
const note = m => say(`    ${c.dim(m)}`);

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

// readline hands over every buffered line at once when stdin is a pipe, so a second
// question() would find stdin already at EOF and never resolve. Queue the lines instead:
// works the same on a tty and under `printf ... | bun run setup`.
let rl;
const pendingLines = [];
const waitingAsks = [];
let stdinClosed = false;

function lineReader() {
  if (rl) {
    return rl;
  }
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', line => {
    const waiting = waitingAsks.shift();
    waiting ? waiting(line) : pendingLines.push(line);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (waitingAsks.length) {
      waitingAsks.shift()('');
    }
  });
  return rl;
}

function nextLine() {
  lineReader();
  if (pendingLines.length) {
    return Promise.resolve(pendingLines.shift());
  }
  if (stdinClosed) {
    return Promise.resolve('');
  }
  return new Promise(resolve => waitingAsks.push(resolve));
}

async function ask(question, fallback = '') {
  if (ASSUME_YES && fallback !== '') {
    return fallback;
  }
  const shown = fallback ? ` ${c.dim(`[${fallback}]`)}` : '';
  process.stdout.write(`  ${question}${shown}: `);
  const answer = (await nextLine()).trim();
  if (!process.stdin.isTTY) {
    say(answer);
  }
  return answer || fallback;
}

async function askRequired(question, validate) {
  for (;;) {
    const answer = await ask(question);
    if (!answer) {
      if (stdinClosed) {
        throw new Error(`no value given for "${question}" and stdin has closed`);
      }
      bad('required');
      continue;
    }
    const problem = validate?.(answer);
    if (problem) {
      bad(problem);
      continue;
    }
    return answer;
  }
}

async function confirm(question, fallback = true) {
  if (ASSUME_YES) {
    return fallback;
  }
  const answer = await ask(
    `${question} ${c.dim(fallback ? '(Y/n)' : '(y/N)')}`,
    fallback ? 'y' : 'n'
  );
  return /^y/i.test(answer);
}

// ---------------------------------------------------------------------------
// env file handling
//
// Rewrites values in place so the comments in .env.example, which document every knob ,
// survive into the generated .env instead of being replaced by a bare key=value dump.
// ---------------------------------------------------------------------------

function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const active = new RegExp(`^${key}=.*$`, 'm');
  if (active.test(text)) {
    return text.replace(active, line);
  }
  const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
  if (commented.test(text)) {
    return text.replace(commented, line);
  }
  return `${text.replace(/\n*$/, '')}\n${line}\n`;
}

function readEnv(path) {
  if (!existsSync(path)) {
    return {};
  }
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const match = raw.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const has = cmd => {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const version = cmd => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function portFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Files that are bind-mounted **as files** by docker-compose. If one is missing on the host,
 * Docker silently creates a *directory* in its place and the tool that reads it runs without
 * auth, a failure that looks like "cookies don't work" rather than "the mount is wrong".
 */
const MOUNTED_FILES = [
  {
    path: 'cookies.json',
    mode: 0o600,
    seed: () =>
      existsSync(join(ROOT, 'cookies.example.json'))
        ? readFileSync(join(ROOT, 'cookies.example.json'), 'utf8')
        : '{}\n',
    what: 'cobalt/instagram/reddit service cookies (read-only to the app)',
  },
  {
    path: 'cobalt-cookies.json',
    mode: 0o600,
    seed: () => '{}\n',
    what: "cobalt's own writable copy, it rewrites this file and drops keys it doesn't know",
  },
  {
    path: 'tiktok-cookies.txt',
    mode: 0o600,
    seed: () => '# Netscape HTTP Cookie File\n',
    what: 'yt-dlp cookie jar (age-restricted TikTok)',
  },
];

const MOUNTED_DIRS = ['data-prod', 'data-test', 'temp', 'logs'];

// What each service in cookies.json needs to be useful. Required names are the ones whose
// absence breaks a feature outright; the rest only widen coverage.
const COOKIE_SERVICES = {
  instagram: { required: ['sessionid'], why: 'photo and carousel posts fail without it' },
  reddit: { required: [], why: 'optional: adds every gallery slide, not just the first' },
  twitter: { required: [], why: 'optional: used by cobalt for gated posts' },
};

const REQUIRED_ENV = ['PROD_DISCORD_TOKEN', 'PROD_CLIENT_ID', 'PROD_POSTGRES_PASSWORD'];
const PLACEHOLDERS = [/^your_/i, /^change_me$/i, /^$/];
const isPlaceholder = v => v === undefined || PLACEHOLDERS.some(p => p.test(v));

async function runChecks() {
  const problems = [];
  const fixables = [];

  heading('Toolchain');
  const bun = version('bun --version');
  if (bun) {
    const major = Number.parseInt(bun, 10);
    major >= 1 ? ok(`bun ${bun}`) : warn(`bun ${bun}, 1.3+ expected`);
  } else {
    bad('bun not found, https://bun.sh');
    problems.push('install bun');
  }

  if (has('docker')) {
    ok(`docker ${version('docker --version')?.replace(/^Docker version /, '') || ''}`.trim());
    try {
      execSync('docker compose version', { stdio: 'ignore' });
      ok('docker compose (v2 plugin)');
    } catch {
      bad('`docker compose` not available, v2 plugin required, not docker-compose v1');
      problems.push('install the docker compose v2 plugin');
    }
    try {
      execSync('docker info', { stdio: 'ignore' });
      ok('docker daemon reachable');
    } catch {
      bad('docker daemon not reachable, is it running, and are you in the docker group?');
      problems.push('start docker / add your user to the docker group');
    }
  } else {
    warn('docker not found, fine for a bare-metal run, required for the compose stack');
  }

  if (has('ffmpeg')) {
    ok('ffmpeg (host)');
  } else {
    note('ffmpeg not on the host. The container ships its own; only local runs need it');
  }

  heading('Files docker mounts as files');
  for (const file of MOUNTED_FILES) {
    const full = join(ROOT, file.path);
    if (!existsSync(full)) {
      bad(`${file.path} missing, docker would mount a DIRECTORY here`);
      note(file.what);
      fixables.push(file);
      problems.push(`create ${file.path}`);
      continue;
    }
    if (statSync(full).isDirectory()) {
      bad(`${file.path} is a DIRECTORY, docker created it because the file was missing`);
      note(`remove it, then re-run setup: rm -rf ${file.path}`);
      problems.push(`${file.path} is a directory`);
      continue;
    }
    const mode = statSync(full).mode & 0o777;
    mode <= file.mode
      ? ok(`${file.path} (${mode.toString(8)})`)
      : warn(`${file.path} is mode ${mode.toString(8)}, holds live sessions, prefer 600`);
  }

  heading('Service cookies');
  const cookiePath = join(ROOT, 'cookies.json');
  let cookies;
  try {
    cookies = JSON.parse(readFileSync(cookiePath, 'utf8'));
  } catch {
    cookies = {};
  }
  for (const [service, meta] of Object.entries(COOKIE_SERVICES)) {
    const value = Array.isArray(cookies[service]) ? cookies[service][0] : '';
    const names = String(value || '')
      .split(';')
      .map(part => part.trim().split('=')[0])
      .filter(Boolean);
    const missing = meta.required.filter(name => !names.includes(name));
    if (names.length === 0) {
      meta.required.length
        ? warn(`${service}: not configured, ${meta.why}`)
        : note(`${service}: not configured, ${meta.why}`);
    } else if (missing.length) {
      bad(`${service}: missing ${missing.join(', ')}, ${meta.why}`);
      problems.push(`add ${missing.join(', ')} to the ${service} entry in cookies.json`);
    } else {
      ok(`${service}: ${names.length} cookie(s)`);
    }
  }
  note('format is in cookies.example.json');

  heading('Writable directories');
  for (const dir of MOUNTED_DIRS) {
    const full = join(ROOT, dir);
    if (existsSync(full)) {
      ok(dir);
    } else {
      warn(`${dir} missing`);
      fixables.push({ dir });
    }
  }

  heading('Configuration');
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    bad('.env missing');
    problems.push('create .env (run `bun run setup`)');
  } else {
    const env = readEnv(envPath);
    for (const key of REQUIRED_ENV) {
      isPlaceholder(env[key])
        ? (bad(`${key} is unset or still the example value`), problems.push(`set ${key}`))
        : ok(key);
    }
    if (isPlaceholder(env.ADMIN_USER_IDS)) {
      warn('ADMIN_USER_IDS empty, nobody can bypass limits or see admin surfaces');
    } else {
      ok('ADMIN_USER_IDS');
    }
    const r2Keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
    const r2Set = r2Keys.filter(k => !isPlaceholder(env[k]));
    if (r2Set.length === 0) {
      note('R2 not configured. Files attach to Discord instead, which is a fine default');
    } else if (r2Set.length === r2Keys.length) {
      isPlaceholder(env.R2_PUBLIC_DOMAIN)
        ? warn('R2 configured but R2_PUBLIC_DOMAIN empty, uploads will have no public URL')
        : ok('R2 fully configured');
    } else {
      bad(`R2 half-configured, missing ${r2Keys.filter(k => isPlaceholder(env[k])).join(', ')}`);
      problems.push('finish or clear the R2 settings');
    }
    for (const [key, value] of Object.entries(env)) {
      if (/^[A-Z]:\\|\\\\/.test(value)) {
        bad(`${key} looks like a Windows path (${value}), use a POSIX path`);
        problems.push(`fix the path in ${key}`);
      }
    }
  }

  heading('Ports');
  const env = readEnv(envPath);
  for (const [key, fallback] of [
    ['PROD_SERVER_PORT', 3000],
    ['PROD_WEBUI_PORT', 3001],
  ]) {
    const port = Number.parseInt(env[key] || fallback, 10);
    if (await portFree(port)) {
      ok(`${port} free (${key})`);
    } else {
      warn(`${port} in use (${key}), fine if that's gronka already running`);
    }
  }

  return { problems, fixables };
}

function applyFixes(fixables) {
  for (const fix of fixables) {
    if (fix.dir) {
      mkdirSync(join(ROOT, fix.dir), { recursive: true });
      ok(`created ${fix.dir}/`);
      continue;
    }
    const full = join(ROOT, fix.path);
    writeFileSync(full, fix.seed());
    chmodSync(full, fix.mode);
    ok(`created ${fix.path} (${fix.mode.toString(8)})`);
  }
}

// ---------------------------------------------------------------------------
// wizard
// ---------------------------------------------------------------------------

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/;
const SNOWFLAKE = /^\d{17,20}$/;

async function wizard() {
  const envPath = join(ROOT, '.env');
  const examplePath = join(ROOT, '.env.example');

  if (!existsSync(examplePath)) {
    bad('.env.example is missing, cannot generate a documented .env from this clone');
    return 1;
  }

  if (existsSync(envPath)) {
    heading('Existing configuration');
    warn('.env already exists');
    if (!(await confirm('Edit it in place? (values you skip are left alone)', true))) {
      note('nothing changed. `bun run setup --check` lists what is missing');
      return 0;
    }
  }

  let text = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : readFileSync(examplePath, 'utf8');
  const current = readEnv(envPath);
  const keep = key => (isPlaceholder(current[key]) ? '' : current[key]);

  heading('Discord');
  note('https://discord.com/developers/applications → your app → Bot');
  note('the token is shown once; Reset Token if you no longer have it');
  const token = keep('PROD_DISCORD_TOKEN')
    ? await ask(
        `bot token ${c.dim('(enter to keep the existing one)')}`,
        keep('PROD_DISCORD_TOKEN')
      )
    : await askRequired('bot token', v =>
        TOKEN_SHAPE.test(v)
          ? null
          : "that doesn't look like a bot token (three dot-separated parts)"
      );
  const clientId = await askRequired('application id', v =>
    SNOWFLAKE.test(v) ? null : 'a Discord id is 17-20 digits'
  );
  const admins = await ask(
    `your Discord user id ${c.dim('(admin: bypasses limits, right-click yourself → Copy User ID)')}`,
    keep('ADMIN_USER_IDS')
  );
  if (admins && !admins.split(',').every(id => SNOWFLAKE.test(id.trim()))) {
    warn('that does not look like a comma-separated list of Discord ids, saving it anyway');
  }
  text = setEnvValue(text, 'PROD_DISCORD_TOKEN', token);
  text = setEnvValue(text, 'PROD_CLIENT_ID', clientId);
  text = setEnvValue(text, 'ADMIN_USER_IDS', admins);

  heading('Database');
  note('the compose stack runs its own Postgres; this password is what it is created with');
  const dbPassword = await askRequired('postgres password', v =>
    v.length >= 8 ? null : 'use at least 8 characters'
  );
  for (const key of ['PROD_POSTGRES_PASSWORD', 'TEST_POSTGRES_PASSWORD']) {
    text = setEnvValue(text, key, dbPassword);
  }

  heading('A second bot for testing');
  note('optional, and strongly recommended: it keeps experiments off your live bot');
  if (await confirm('Configure a test bot too?', false)) {
    text = setEnvValue(text, 'TEST_DISCORD_TOKEN', await askRequired('test bot token'));
    text = setEnvValue(
      text,
      'TEST_CLIENT_ID',
      await askRequired('test application id', v => (SNOWFLAKE.test(v) ? null : '17-20 digits'))
    );
  } else {
    note('skipped. `bun run bot:test` needs the TEST_* values filled in');
  }

  heading('Support server');
  note('shown in /info and the ban-appeal embed; leave empty and neither mentions a server');
  note('do not point your users at someone else\u2019s Discord; they cannot answer for your bot');
  text = setEnvValue(
    text,
    'SUPPORT_INVITE_URL',
    await ask('invite url', keep('SUPPORT_INVITE_URL'))
  );

  heading('Cloudflare R2');
  note('optional. Without it, files attach straight to Discord and nothing is stored off-box.');
  note('With it, files too big for Discord get a cdn URL instead of failing.');
  if (await confirm('Configure R2 storage?', false)) {
    text = setEnvValue(text, 'R2_ACCOUNT_ID', await askRequired('account id'));
    text = setEnvValue(text, 'R2_ACCESS_KEY_ID', await askRequired('access key id'));
    text = setEnvValue(text, 'R2_SECRET_ACCESS_KEY', await askRequired('secret access key'));
    text = setEnvValue(text, 'R2_BUCKET_NAME', await askRequired('bucket name'));
    note('the public domain is the bucket’s custom domain, without a scheme');
    const domain = await askRequired('public domain (e.g. cdn.example.com)');
    text = setEnvValue(text, 'R2_PUBLIC_DOMAIN', domain);
    if (await confirm('Expire uploads automatically?', true)) {
      text = setEnvValue(text, 'R2_TEMP_UPLOADS_ENABLED', 'true');
      text = setEnvValue(text, 'R2_CLEANUP_ENABLED', 'true');
      text = setEnvValue(
        text,
        'R2_TEMP_UPLOAD_TTL_HOURS',
        await ask('hours to keep an upload', '72')
      );
    }
    warn('an R2 bucket on a public domain is readable by anyone who has the URL');
  } else {
    note('skipped, everything still works, just without a CDN');
  }

  // mode on create closes the window where .env briefly exists at 0644 holding the Discord
  // token and R2 keys; chmod still covers the case where the file already existed.
  writeFileSync(envPath, text, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  ok('wrote .env (600), keeping the documentation comments from .env.example');

  heading('Creating what docker needs');
  const { fixables } = await runChecksQuiet();
  fixables.length ? applyFixes(fixables) : ok('nothing missing');

  return 0;
}

async function runChecksQuiet() {
  const original = console.log;
  console.log = () => {};
  try {
    return await runChecks();
  } finally {
    console.log = original;
  }
}

function nextSteps() {
  heading('Next');
  say(`  1. ${c.cyan('docker compose up -d --build')}      build and start the stack`);
  say(`  2. ${c.cyan('bun run docker:register')}            register the slash commands`);
  say(`  3. ${c.cyan('docker compose logs app --tail 30')}  expect "bot logged in as ..."`);
  say('');
  note('invite the bot with Scopes: bot + applications.commands');
  note('re-run `bun run setup --check` any time to re-validate an install');
}

// ---------------------------------------------------------------------------

async function main() {
  say(c.bold('\ngronka setup'));
  say(c.dim(RULE));

  if (CHECK) {
    const { problems } = await runChecks();
    heading('Result');
    if (problems.length === 0) {
      ok('ready to start');
      return 0;
    }
    bad(`${problems.length} problem(s):`);
    problems.forEach(p => say(`      - ${p}`));
    note('`bun run setup --repair` fixes the ones needing no input');
    return 1;
  }

  if (REPAIR) {
    const { fixables, problems } = await runChecks();
    heading('Repair');
    fixables.length ? applyFixes(fixables) : ok('nothing to create');
    return problems.length > fixables.length ? 1 : 0;
  }

  const code = await wizard();
  if (code === 0) {
    nextSteps();
  }
  return code;
}

main()
  .then(code => {
    rl?.close();
    process.exit(code);
  })
  .catch(error => {
    rl?.close();
    bad(error.message);
    process.exit(1);
  });
