import { test, describe } from 'bun:test';
import assert from 'node:assert';

describe('initPostgresConnection', () => {
  test('retries after a failed connect instead of caching the rejection', async () => {
    const { initPostgresConnection, getPostgresConnection } =
      await import('../../src/utils/database/connection.js?retry');
    const goodPort = process.env.TEST_POSTGRES_PORT;
    process.env.TEST_POSTGRES_PORT = '1';
    try {
      await assert.rejects(initPostgresConnection());
    } finally {
      if (goodPort === undefined) delete process.env.TEST_POSTGRES_PORT;
      else process.env.TEST_POSTGRES_PORT = goodPort;
    }
    const sql = await initPostgresConnection();
    assert.strictEqual(getPostgresConnection(), sql);
    await sql.end();
  });
});
