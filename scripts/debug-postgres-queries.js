#!/usr/bin/env node

/**
 * Debug script to test PostgreSQL queries directly
 * This helps identify what's actually being returned from the database
 */

import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

// Get PostgreSQL connection config
function getPostgresConfig() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Support TEST_ prefix for test database
  const prefix = process.env.TEST_DATABASE_TYPE ? 'TEST_' : '';
  const hostKey = `${prefix}POSTGRES_HOST`;
  const portKey = `${prefix}POSTGRES_PORT`;
  const dbKey = `${prefix}POSTGRES_DB`;
  const userKey = `${prefix}POSTGRES_USER`;
  const passKey = `${prefix}POSTGRES_PASSWORD`;

  return {
    host: process.env[hostKey] || process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env[portKey] || process.env.POSTGRES_PORT || '5432', 10),
    database: process.env[dbKey] || process.env.POSTGRES_DB || 'gronka',
    username: process.env[userKey] || process.env.POSTGRES_USER || 'gronka',
    password: process.env[passKey] || process.env.POSTGRES_PASSWORD || 'gronka',
  };
}

async function testQueries() {
  try {
    const config = getPostgresConfig();
    console.log('PostgreSQL Config:', {
      host: config.host || 'DATABASE_URL',
      port: config.port || 'N/A',
      database: config.database || 'N/A',
      username: config.username || 'N/A',
    });
    console.log('Connecting...\n');

    const sql = postgres(config);

    // Test connection
    await sql`SELECT 1`;
    console.log('✓ Connected successfully\n');

    // Test 1: Simple query
    console.log('Test 1: Simple SELECT * FROM user_metrics');
    const test1 = await sql`SELECT * FROM user_metrics LIMIT 5`;
    console.log('Result type:', typeof test1);
    console.log('Is Array:', Array.isArray(test1));
    console.log('Length:', test1?.length);
    console.log('First item:', test1?.[0]);
    console.log('Full result:', JSON.stringify(test1, null, 2));
    console.log('');

    // Test 2: Count query
    console.log('Test 2: SELECT COUNT(*) FROM user_metrics');
    const test2 = await sql`SELECT COUNT(*) as count FROM user_metrics`;
    console.log('Result type:', typeof test2);
    console.log('Is Array:', Array.isArray(test2));
    console.log('Result:', test2);
    console.log('Count value:', test2?.[0]?.count);
    console.log('');

    // Test 3: Using sql.unsafe (like getAllUsersMetrics does)
    console.log('Test 3: Using sql.unsafe() with ORDER BY');
    const query = 'SELECT * FROM user_metrics ORDER BY total_commands DESC LIMIT 5';
    const test3 = await sql.unsafe(query);
    console.log('Result type:', typeof test3);
    console.log('Is Array:', Array.isArray(test3));
    console.log('Length:', test3?.length);
    console.log('First item:', test3?.[0]);
    console.log('Full result:', JSON.stringify(test3, null, 2));
    console.log('');

    // Test 4: Using sql.unsafe with parameters
    console.log('Test 4: Using sql.unsafe() with parameters');
    const query2 =
      'SELECT * FROM user_metrics WHERE username ILIKE $1 ORDER BY total_commands DESC LIMIT $2';
    const params2 = ['%test%', 5];
    const test4 = await sql.unsafe(query2, params2);
    console.log('Result type:', typeof test4);
    console.log('Is Array:', Array.isArray(test4));
    console.log('Length:', test4?.length);
    console.log('Full result:', JSON.stringify(test4, null, 2));
    console.log('');

    // Test 5: Check table structure
    console.log('Test 5: Check user_metrics table structure');
    const test5 = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'user_metrics'
      ORDER BY ordinal_position
    `;
    console.log('Columns:', test5);
    console.log('');

    // Test 6: Check if table has data
    console.log('Test 6: Check row count');
    const test6 = await sql`SELECT COUNT(*) as count FROM user_metrics`;
    const count = parseInt(test6[0]?.count || 0, 10);
    console.log('Row count:', count);
    if (count === 0) {
      console.log('⚠️  WARNING: user_metrics table is empty!');
    }
    console.log('');

    // Test 7: Simulate getAllUsersMetrics query exactly
    console.log('Test 7: Simulate getAllUsersMetrics query');
    const options = {
      search: null,
      sortBy: 'total_commands',
      sortDesc: true,
      limit: 50,
      offset: 0,
    };

    let query7 = 'SELECT * FROM user_metrics';
    const params7 = [];

    if (options.search) {
      query7 += ` WHERE username ILIKE $${params7.length + 1}`;
      params7.push(`%${options.search}%`);
    }

    query7 += ` ORDER BY ${options.sortBy} ${options.sortDesc ? 'DESC' : 'ASC'}`;

    if (options.limit !== null && options.limit !== undefined) {
      query7 += ` LIMIT $${params7.length + 1}`;
      params7.push(options.limit);
    }

    if (options.offset !== null && options.offset !== undefined) {
      query7 += ` OFFSET $${params7.length + 1}`;
      params7.push(options.offset);
    }

    console.log('Query:', query7);
    console.log('Params:', params7);

    const test7 = params7.length > 0 ? await sql.unsafe(query7, params7) : await sql.unsafe(query7);

    console.log('Result type:', typeof test7);
    console.log('Is Array:', Array.isArray(test7));
    console.log('Length:', test7?.length);
    console.log('First item:', test7?.[0]);
    console.log('Full result (first 2):', JSON.stringify(test7?.slice(0, 2), null, 2));
    console.log('');

    await sql.end();
    console.log('✓ All tests completed');
  } catch (error) {
    console.error('\n✗ Error:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testQueries();
