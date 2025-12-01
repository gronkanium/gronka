#!/usr/bin/env node

/**
 * Simple helper to test get24HourStats() with the current DATABASE_TYPE.
 * Logs the returned shape and values without modifying any data.
 */

import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    const { get24HourStats } = await import('../src/utils/database/stats.js');

    console.log('testing get24HourStats with DATABASE_TYPE =', process.env.DATABASE_TYPE);

    const stats = await get24HourStats();

    console.log('\n=== get24HourStats result ===');
    console.log('type:', typeof stats);
    console.log('keys:', stats && typeof stats === 'object' ? Object.keys(stats) : null);
    console.log('value:', JSON.stringify(stats, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('error while testing get24HourStats:', error);
    process.exit(1);
  }
}

main();
