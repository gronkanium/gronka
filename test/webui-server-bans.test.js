import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { initDatabase, banUser, unbanUser, getBan, listBans } from '../src/utils/database.js';

let app;
let server;
let baseUrl;

before(async () => {
  await initDatabase();
  const { createApp } = await import('../src/webui-server/app.js');
  app = createApp();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  // Don't close database here - it's shared across parallel test files
});

describe('bans database', () => {
  test('banUser then getBan returns the ban record', async () => {
    const userId = `ban-db-user-${Date.now()}`;

    await banUser(userId, 'test reason', true);
    const ban = await getBan(userId);

    assert.ok(ban);
    assert.strictEqual(ban.user_id, userId);
    assert.strictEqual(ban.reason, 'test reason');
    assert.strictEqual(ban.appeal_allowed, true);
  });

  test('getBan returns null for a user who is not banned', async () => {
    const ban = await getBan(`ban-db-nobody-${Date.now()}`);
    assert.strictEqual(ban, null);
  });

  test('banUser is an upsert - re-banning updates reason and appeal flag', async () => {
    const userId = `ban-db-upsert-${Date.now()}`;

    await banUser(userId, 'first reason', true);
    await banUser(userId, 'second reason', false);

    const ban = await getBan(userId);
    assert.strictEqual(ban.reason, 'second reason');
    assert.strictEqual(ban.appeal_allowed, false);
  });

  test('unbanUser removes the ban and returns true', async () => {
    const userId = `ban-db-unban-${Date.now()}`;
    await banUser(userId, 'temp reason', true);

    const deleted = await unbanUser(userId);
    assert.strictEqual(deleted, true);

    const ban = await getBan(userId);
    assert.strictEqual(ban, null);
  });

  test('unbanUser returns false when the user was not banned', async () => {
    const deleted = await unbanUser(`ban-db-never-banned-${Date.now()}`);
    assert.strictEqual(deleted, false);
  });

  test('listBans includes banned users, most recent first', async () => {
    const userIdA = `ban-db-list-a-${Date.now()}`;
    const userIdB = `ban-db-list-b-${Date.now()}`;

    await banUser(userIdA, 'reason a', true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await banUser(userIdB, 'reason b', true);

    const bans = await listBans();
    const idxA = bans.findIndex(b => b.user_id === userIdA);
    const idxB = bans.findIndex(b => b.user_id === userIdB);

    assert.ok(idxA !== -1 && idxB !== -1);
    assert.ok(idxB < idxA, 'more recently banned user should sort first');
  });
});

describe('bans API', () => {
  test('POST /api/bans bans a user', async () => {
    const userId = `ban-api-post-${Date.now()}`;

    const response = await fetch(`${baseUrl}/api/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason: 'spamming', appealAllowed: true }),
    });

    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.ban.user_id, userId);
    assert.strictEqual(data.ban.reason, 'spamming');
  });

  test('POST /api/bans requires userId and reason', async () => {
    const noUserId = await fetch(`${baseUrl}/api/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spamming' }),
    });
    assert.strictEqual(noUserId.status, 400);

    const noReason = await fetch(`${baseUrl}/api/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'someone' }),
    });
    assert.strictEqual(noReason.status, 400);
  });

  test('GET /api/bans lists banned users', async () => {
    const userId = `ban-api-list-${Date.now()}`;
    await banUser(userId, 'listed reason', true);

    const response = await fetch(`${baseUrl}/api/bans`);
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.bans));
    assert.ok(data.bans.some(b => b.user_id === userId));
  });

  test('DELETE /api/bans/:userId unbans a user', async () => {
    const userId = `ban-api-delete-${Date.now()}`;
    await banUser(userId, 'to be unbanned', true);

    const response = await fetch(`${baseUrl}/api/bans/${userId}`, { method: 'DELETE' });
    assert.strictEqual(response.status, 200);

    const ban = await getBan(userId);
    assert.strictEqual(ban, null);
  });

  test('DELETE /api/bans/:userId returns 404 when not banned', async () => {
    const response = await fetch(`${baseUrl}/api/bans/never-banned-${Date.now()}`, {
      method: 'DELETE',
    });
    assert.strictEqual(response.status, 404);
  });
});
