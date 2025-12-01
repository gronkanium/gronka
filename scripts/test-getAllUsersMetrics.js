#!/usr/bin/env node

/**
 * Test getAllUsersMetrics function directly
 */

import dotenv from 'dotenv';
dotenv.config();

// Set test environment
process.env.DATABASE_TYPE = 'postgres';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'gronka';
process.env.POSTGRES_PASSWORD = 'gronka';
process.env.POSTGRES_DB = 'gronka_test';

async function test() {
  try {
    console.log('Importing getAllUsersMetrics...');
    const { getAllUsersMetrics, getUserMetricsCount } =
      await import('../src/utils/database/metrics-pg.js');

    console.log('Calling getAllUsersMetrics...');
    const options = {
      search: null,
      sortBy: 'total_commands',
      sortDesc: true,
      limit: 50,
      offset: 0,
    };

    const users = await getAllUsersMetrics(options);
    console.log('\n=== getAllUsersMetrics result ===');
    console.log('Type:', typeof users);
    console.log('Is Array:', Array.isArray(users));
    console.log('Length:', users?.length);
    console.log('Value:', JSON.stringify(users, null, 2));
    console.log('Constructor:', users?.constructor?.name);

    console.log('\nCalling getUserMetricsCount...');
    const total = await getUserMetricsCount({ search: null });
    console.log('\n=== getUserMetricsCount result ===');
    console.log('Type:', typeof total);
    console.log('Is Number:', typeof total === 'number');
    console.log('Value:', total);
    console.log('Constructor:', total?.constructor?.name);

    // Test what happens when we JSON.stringify
    console.log('\n=== JSON.stringify test ===');
    const jsonUsers = JSON.stringify(users);
    const jsonTotal = JSON.stringify(total);
    console.log('JSON users:', jsonUsers.substring(0, 200));
    console.log('JSON total:', jsonTotal);

    // Test what the route would send
    const usersArray = Array.isArray(users) ? users : [];
    const totalCount = typeof total === 'number' ? total : 0;
    const response = {
      users: usersArray,
      total: totalCount,
      limit: options.limit,
      offset: options.offset,
    };
    console.log('\n=== Route response ===');
    console.log(JSON.stringify(response, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

test();
