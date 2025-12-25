#!/usr/bin/env node

/**
 * Test database.js wrapper functions
 */

import dotenv from 'dotenv';
dotenv.config();

// Set test environment
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'gronka';
process.env.POSTGRES_PASSWORD = 'gronka';
process.env.POSTGRES_DB = 'gronka_test';

async function test() {
  try {
    console.log('Importing from database.js wrapper...');
    const { getAllUsersMetrics, getUserMetricsCount } = await import('../src/utils/database.js');

    console.log('Calling getAllUsersMetrics through wrapper...');
    const options = {
      search: null,
      sortBy: 'total_commands',
      sortDesc: true,
      limit: 50,
      offset: 0,
    };

    const users = await getAllUsersMetrics(options);
    console.log('\n=== getAllUsersMetrics (via wrapper) result ===');
    console.log('Type:', typeof users);
    console.log('Is Array:', Array.isArray(users));
    console.log('Length:', users?.length);
    console.log('Constructor:', users?.constructor?.name);
    console.log('Value (first 200 chars):', JSON.stringify(users).substring(0, 200));

    // Check if it's an error object
    if (users && typeof users === 'object' && !Array.isArray(users)) {
      console.log('⚠️  WARNING: Result is an object but not an array!');
      console.log('Keys:', Object.keys(users));
      console.log('Full object:', JSON.stringify(users, null, 2));
    }

    console.log('\nCalling getUserMetricsCount through wrapper...');
    const total = await getUserMetricsCount({ search: null });
    console.log('\n=== getUserMetricsCount (via wrapper) result ===');
    console.log('Type:', typeof total);
    console.log('Is Number:', typeof total === 'number');
    console.log('Value:', total);
    console.log('Constructor:', total?.constructor?.name);

    // Check if it's an error object
    if (total && typeof total === 'object') {
      console.log('⚠️  WARNING: Result is an object but should be a number!');
      console.log('Keys:', Object.keys(total));
      console.log('Full object:', JSON.stringify(total, null, 2));
    }

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
