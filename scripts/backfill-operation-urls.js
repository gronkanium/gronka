#!/usr/bin/env node

import {
  initDatabase,
  getOperationTrace,
  getRecentOperations,
  updateOperationLogMetadata,
} from '../src/utils/database.js';

/**
 * Extract URL from various sources in operation logs
 */
function extractUrlFromLogs(trace) {
  if (!trace || !trace.logs) {
    return null;
  }

  // First, check if originalUrl is already in the created log metadata
  const createdLog = trace.logs.find(log => log.step === 'created');
  if (createdLog?.metadata?.originalUrl) {
    return createdLog.metadata.originalUrl;
  }

  // Check all logs for originalUrl in metadata
  for (const log of trace.logs) {
    if (log.metadata?.originalUrl) {
      return log.metadata.originalUrl;
    }
  }

  // Check error logs for URL patterns in messages
  const errorLogs = trace.logs.filter(log => log.step === 'error');
  for (const log of errorLogs) {
    if (log.message) {
      // Try to extract URL from error message
      const urlPattern = /(https?:\/\/[^\s]+)/gi;
      const matches = log.message.match(urlPattern);
      if (matches && matches.length > 0) {
        return matches[0];
      }
    }
  }

  // Check metadata in error logs
  for (const log of errorLogs) {
    if (log.metadata) {
      // Check various possible URL fields
      if (log.metadata.url) return log.metadata.url;
      if (log.metadata.originalUrl) return log.metadata.originalUrl;
      if (log.metadata.sourceUrl) return log.metadata.sourceUrl;
    }
  }

  return null;
}

/**
 * Check if operation has invalid_social_media_url error
 */
function hasInvalidSocialMediaUrlError(trace) {
  if (!trace || !trace.logs) {
    return false;
  }

  // Check created log metadata for errorType
  const createdLog = trace.logs.find(log => log.step === 'created');
  if (createdLog?.metadata?.errorType === 'invalid_social_media_url') {
    return true;
  }

  // Check error logs for errorType
  const errorLogs = trace.logs.filter(log => log.step === 'error');
  for (const log of errorLogs) {
    if (log.metadata?.errorType === 'invalid_social_media_url') {
      return true;
    }
    // Also check error message
    if (log.message && log.message.toLowerCase().includes('invalid social media url')) {
      return true;
    }
    if (
      log.message &&
      log.message.toLowerCase().includes('url is not from a supported social media platform')
    ) {
      return true;
    }
  }

  return false;
}

async function main() {
  // Check if we're in production mode
  const postgresDb = process.env.POSTGRES_DB || process.env.PROD_POSTGRES_DB || 'gronka';
  const postgresHost = process.env.POSTGRES_HOST || process.env.PROD_POSTGRES_HOST || 'localhost';

  if (postgresDb.includes('test') && process.env.NODE_ENV !== 'test') {
    console.warn('WARNING: Using test database. This script will modify the test database.');
    console.warn('   Set PROD_POSTGRES_DB or POSTGRES_DB to use production database.');
    console.warn('   Example: PROD_POSTGRES_DB=gronka node scripts/backfill-operation-urls.js\n');
  } else {
    console.log(`Using PostgreSQL database: ${postgresDb} on ${postgresHost}`);
  }

  console.log('Initializing database...');
  await initDatabase();

  console.log('Fetching all operations from database...');
  // Get a large number of operations to check
  const allOperations = getRecentOperations(10000);

  console.log(`Found ${allOperations.length} operations to check.`);

  let processedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const operation of allOperations) {
    try {
      // Only process operations with invalid_social_media_url error
      const trace = await getOperationTrace(operation.id);
      if (!trace) {
        skippedCount++;
        continue;
      }

      if (!hasInvalidSocialMediaUrlError(trace)) {
        skippedCount++;
        continue;
      }

      processedCount++;

      // Check if originalUrl already exists
      const createdLog = trace.logs.find(log => log.step === 'created');
      if (createdLog?.metadata?.originalUrl) {
        console.log(
          `  ✓ ${operation.id} already has originalUrl: ${createdLog.metadata.originalUrl}`
        );
        continue;
      }

      // Try to extract URL from logs
      const url = extractUrlFromLogs(trace);
      if (!url) {
        console.log(`  ⚠ ${operation.id} - No URL found in logs`);
        continue;
      }

      // Update the created log metadata
      const success = await updateOperationLogMetadata(operation.id, 'created', {
        originalUrl: url,
      });
      if (success) {
        updatedCount++;
        console.log(`  ✓ ${operation.id} - Updated with URL: ${url}`);
      } else {
        errorCount++;
        console.error(`  ✗ ${operation.id} - Failed to update metadata`);
      }
    } catch (error) {
      errorCount++;
      console.error(`  ✗ ${operation.id} - Error: ${error.message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total operations checked: ${allOperations.length}`);
  console.log(`Operations with invalid_social_media_url: ${processedCount}`);
  console.log(`Successfully updated: ${updatedCount}`);
  console.log(`Already had URL: ${processedCount - updatedCount - errorCount}`);
  console.log(`Skipped (no matching error): ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);

  if (updatedCount > 0) {
    console.log('\n✓ Backfill complete! URLs should now appear in the webUI.');
    console.log('Note: You may need to refresh the Requests page to see the updated URLs.');
  } else {
    console.log('\nNo operations needed updating.');
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Error during backfill:', error);
  process.exit(1);
});
