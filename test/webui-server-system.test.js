import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/utils/database.js';
import { readSessions } from '../src/webui-server/sessions.js';

let server;
let baseUrl;
let dir;

beforeAll(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  await new Promise(resolve => {
    server = createApp().listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gronka-sessions-'));
});

afterAll(async () => {
  if (server) server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('sessions', () => {
  test('reports login state and expiry without any cookie value', async () => {
    const cookiesPath = path.join(dir, 'cookies.json');
    const jarPath = path.join(dir, 'jar.txt');
    const expires = Math.floor(Date.now() / 1000) + 86400;
    await fs.writeFile(
      cookiesPath,
      JSON.stringify({ instagram: ['sessionid=SECRET-IG; csrftoken=SECRET-CSRF'], twitter: [] })
    );
    await fs.writeFile(
      jarPath,
      [
        '# Netscape HTTP Cookie File',
        `.youtube.com\tTRUE\t/\tTRUE\t${expires}\tSID\tSECRET-YT`,
        `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${expires + 50}\tLOGIN_INFO\tSECRET-LOGIN`,
        `.tiktok.com\tTRUE\t/\tTRUE\t${expires}\ttt_webid\tSECRET-TT`,
      ].join('\n')
    );

    const sessions = await readSessions({ cookiesPath, jarPath });
    const by = Object.fromEntries(sessions.map(s => [s.id, s]));

    assert.ok(!JSON.stringify(sessions).includes('SECRET'));
    assert.strictEqual(by.instagram.loggedIn, true);
    assert.strictEqual(by.instagram.cookies, 2);
    assert.strictEqual(by.twitter.loggedIn, false);
    assert.strictEqual(by.youtube.loggedIn, true);
    assert.strictEqual(by.youtube.expires, expires * 1000);
    assert.strictEqual(by.tiktok.loggedIn, false);
    assert.strictEqual(by.tiktok.cookies, 1);
    assert.ok(sessions.every(s => s.fileFound && s.fileChanged > 0));
  });

  test('a missing file reads as not found, not as an error', async () => {
    const sessions = await readSessions({
      cookiesPath: path.join(dir, 'absent.json'),
      jarPath: undefined,
    });
    assert.ok(sessions.length > 0);
    assert.ok(sessions.every(s => !s.fileFound && !s.loggedIn));
  });
});

describe('system routes', () => {
  test('GET /api/system/deps answers even when a dependency is down', async () => {
    const response = await fetch(`${baseUrl}/api/system/deps`);
    assert.strictEqual(response.status, 200);
    const { deps, sessions } = await response.json();

    assert.deepStrictEqual(deps.map(d => d.id).sort(), [
      'cobalt',
      'disk',
      'postgres',
      'r2',
      'ytdlp',
    ]);
    assert.ok(deps.every(d => d.label && ['ok', 'warn', 'error'].includes(d.status)));
    assert.strictEqual(deps.find(d => d.id === 'postgres').status, 'ok');
    assert.ok(Array.isArray(sessions));
  });
});
