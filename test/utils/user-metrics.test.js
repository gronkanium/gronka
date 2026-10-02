import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import postgres from 'postgres';
import { initDatabase } from '../../src/utils/database.js';
import { recordUserCommand, getUserMetrics } from '../../src/utils/database/metrics-pg.js';
import { getPostgresConfig } from '../../src/utils/database/connection.js';
import { mergeUsersIntoUserMetrics } from '../../src/utils/database/schema-pg.js';

beforeAll(async () => {
  await initDatabase();
});

describe('recordUserCommand', () => {
  test('counts requests and failures, keeps first use, moves last use', async () => {
    const id = `um-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await recordUserCommand(id, { at: 1000 });
    await recordUserCommand(id, { failed: true, at: 3000 });
    await recordUserCommand(id, { at: 2000 });
    const m = await getUserMetrics(id);
    assert.strictEqual(m.total_commands, 3);
    assert.strictEqual(m.failed_commands, 1);
    assert.strictEqual(m.first_used, 1000);
    assert.strictEqual(m.last_command_at, 3000);
  });

  test('stores nothing but counts and two dates', async () => {
    const id = `um-cols-${Date.now()}`;
    await recordUserCommand(id);
    const m = await getUserMetrics(id);
    assert.deepStrictEqual(Object.keys(m).sort(), [
      'failed_commands',
      'first_used',
      'last_command_at',
      'total_commands',
      'user_id',
    ]);
  });
});

describe('mergeUsersIntoUserMetrics', () => {
  const schema = `mig_${Date.now()}`;
  let sql;

  beforeAll(async () => {
    const config = getPostgresConfig();
    sql = postgres({ ...config, max: 1, connection: { search_path: schema } });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql`CREATE TABLE users (user_id TEXT PRIMARY KEY, first_used BIGINT NOT NULL, last_used BIGINT NOT NULL)`;
    await sql`
      CREATE TABLE user_metrics (
        user_id TEXT PRIMARY KEY, total_commands BIGINT DEFAULT 0,
        successful_commands BIGINT DEFAULT 0, failed_commands BIGINT DEFAULT 0,
        total_convert BIGINT DEFAULT 0, total_download BIGINT DEFAULT 0,
        total_optimize BIGINT DEFAULT 0, total_info BIGINT DEFAULT 0,
        total_file_size BIGINT DEFAULT 0, last_command_at BIGINT, updated_at BIGINT NOT NULL)`;
    await sql`CREATE TABLE processed_urls (url_hash TEXT PRIMARY KEY, processed_at BIGINT NOT NULL, user_id TEXT)`;
    await sql`INSERT INTO processed_urls VALUES ('h1', 300, 'no-users-row'), ('h2', 350, 'no-users-row')`;
    await sql`INSERT INTO users VALUES ('a', 100, 900), ('refused', 50, 50)`;
    await sql`
      INSERT INTO user_metrics (user_id, total_commands, failed_commands, total_file_size, last_command_at, updated_at)
      VALUES ('a', 7, 2, 12345, 800, 800), ('no-users-row', 1, 0, 0, 400, 400)`;
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end();
  });

  test('backfills first use, drops users and the extra columns, and runs twice', async () => {
    await mergeUsersIntoUserMetrics(sql);
    await mergeUsersIntoUserMetrics(sql);

    const rows = await sql`SELECT * FROM user_metrics ORDER BY user_id`;
    assert.deepStrictEqual(
      rows.map(r => ({ ...r })),
      [
        {
          user_id: 'a',
          total_commands: '7',
          failed_commands: '2',
          first_used: '100',
          last_command_at: '800',
        },
        {
          user_id: 'no-users-row',
          total_commands: '1',
          failed_commands: '0',
          first_used: '300',
          last_command_at: '400',
        },
      ]
    );
    const [{ exists }] = await sql`SELECT to_regclass('users') IS NOT NULL AS exists`;
    assert.strictEqual(exists, false);
  });
});
