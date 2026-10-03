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

  test('upgrading purges what earlier versions stored and keeps failures and live jobs', async () => {
    const sql = clients[0];
    const job = status => sql`
      INSERT INTO media_jobs (kind, args, reply, status, created_at, timestamp)
      VALUES ('download', ${sql.json({ url: 'https://example.com/v/1' })}, ${sql.json({ channelId: '1' })},
              ${status}, 1, ${Date.now()})`;
    const alert = (component, title, metadata) => sql`
      INSERT INTO alerts (timestamp, severity, component, title, message, metadata)
      VALUES (${Date.now()}, 'info', ${component}, ${title}, 'm', ${metadata})`;
    await job('done');
    await job('queued');
    await job('running');
    await alert('bot', 'command success', '{"command":"download","duration":1}');
    await alert('bot', 'command failed', '{"command":"download","error":"https://example.com/a"}');
    await alert(
      'bot',
      'command failed',
      '{"command":"download","error":null,"errorClass":null,"source":null}'
    );
    await alert('r2-cleanup', 'R2 cleanup: deletions failed', '{"count":1}');
    await sql`INSERT INTO bot_settings (key, value, updated_at) VALUES ('ntfy_topic', 'x', 1), ('queue_paused', 'false', 1)`;
    await sql`DELETE FROM schema_migrations WHERE name = 'purge_earlier_rows'`;

    await applySchema(sql);

    const jobs = await sql`SELECT status FROM media_jobs ORDER BY status`;
    assert.deepStrictEqual(
      jobs.map(j => j.status),
      ['queued', 'running']
    );
    const alerts = await sql`SELECT component, metadata FROM alerts ORDER BY component`;
    assert.deepStrictEqual(
      alerts.map(a => a.component),
      ['bot', 'r2-cleanup']
    );
    assert.ok(alerts[0].metadata.includes('"errorClass"'));
    const settings = await sql`SELECT key FROM bot_settings ORDER BY key`;
    assert.deepStrictEqual(
      settings.map(r => r.key),
      ['queue_paused']
    );
  });
});
