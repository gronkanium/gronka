#!/usr/bin/env node

import {
  initDatabase,
  getStuckOperations,
  markOperationAsFailed,
  getOperationTrace,
  getRecentOperations,
} from '../src/utils/database.js';
import axios from 'axios';

const MAX_AGE_MINUTES = 10;
const WEBUI_URL = process.env.WEBUI_URL || process.env.WEBUI_SERVER_URL || 'http://localhost:3001';

async function main() {
  console.log('Initializing database...');
  await initDatabase();

  console.log(
    `Finding operations stuck in running status (older than ${MAX_AGE_MINUTES} minutes)...`
  );
  const stuckOperationIds = await getStuckOperations(MAX_AGE_MINUTES);

  if (stuckOperationIds.length === 0) {
    console.log('No stuck operations found.');
    process.exit(0);
  }

  console.log(`Found ${stuckOperationIds.length} stuck operation(s):`);
  for (const operationId of stuckOperationIds) {
    const trace = await getOperationTrace(operationId);
    const username = trace?.context?.username || 'unknown';
    const operationType = trace?.context?.operationType || 'unknown';
    const timestamp = trace?.logs?.[0]?.timestamp || 'unknown';
    const date = timestamp !== 'unknown' ? new Date(timestamp).toISOString() : 'unknown';

    console.log(`  - ${operationId} (${operationType}, user: ${username}, started: ${date})`);
  }

  console.log('\nMarking stuck operations as failed...');
  let fixedCount = 0;
  const fixedOperations = [];

  for (const operationId of stuckOperationIds) {
    try {
      await markOperationAsFailed(operationId);

      // Reconstruct operation from database to get updated status
      const recentOps = await getRecentOperations(1000);
      const reconstructedOp = recentOps.find(op => op.id === operationId);

      if (reconstructedOp) {
        fixedOperations.push(reconstructedOp);
      }

      fixedCount++;
      console.log(`  ✓ Marked ${operationId} as failed`);
    } catch (error) {
      console.error(`  ✗ Failed to mark ${operationId} as failed:`, error.message);
    }
  }

  // Send updates to webui server if available
  if (fixedOperations.length > 0) {
    console.log('\nSending updates to webui server...');
    for (const operation of fixedOperations) {
      try {
        await axios.post(`${WEBUI_URL}/api/operations`, operation, {
          timeout: 1000,
          headers: { 'Content-Type': 'application/json' },
        });
        console.log(`  ✓ Sent update for ${operation.id} to webui`);
      } catch (error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          console.log(`  ⚠ Webui server not available, updates will appear after restart`);
        } else {
          console.error(`  ✗ Failed to send update for ${operation.id}:`, error.message);
        }
      }
    }
  }

  console.log(`\nFixed ${fixedCount} out of ${stuckOperationIds.length} stuck operation(s).`);
  process.exit(0);
}

main().catch(error => {
  console.error('Error fixing stuck operations:', error);
  process.exit(1);
});
