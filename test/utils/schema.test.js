import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import postgres from 'postgres';
import { getPostgresConfig } from '../../src/utils/database/connection.js';
import { applySchema } from '../../src/utils/database/init.js';

describe('applySchema', () => {
  const schema = `schema_${Date.now()}`;
  const clients = [];
  const connect = () => {
    const sql = postgres({
      ...getPostgresConfig(),
      max: 1,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    clients.push(sql);
    return sql;
  };

  beforeAll(async () => {
    await connect().unsafe(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    await clients[0].unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all(clients.map(sql => sql.end()));
  });

  test('four processes booting at once build one schema and record each migration once', async () => {
    await Promise.all([connect(), connect(), connect(), connect()].map(applySchema));

    const migrations = await clients[0]`SELECT name FROM schema_migrations`;
    assert.strictEqual(migrations.length, new Set(migrations.map(m => m.name)).size);
    assert.ok(migrations.length >= 3);
    const [{ exists }] = await clients[0]`SELECT to_regclass('media_jobs') IS NOT NULL AS exists`;
    assert.strictEqual(exists, true);
  });

  test('a second boot changes nothing', async () => {
    const before = await clients[0]`SELECT name, applied_at FROM schema_migrations ORDER BY name`;
    await applySchema(clients[0]);
    const after = await clients[0]`SELECT name, applied_at FROM schema_migrations ORDER BY name`;
    assert.deepStrictEqual(after, before);
  });
});
