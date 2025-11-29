#!/usr/bin/env node

import { checkDockerDaemon, info, execOrError, getContainerEnvVar } from './utils.js';

checkDockerDaemon();

info('Running backfill script for Docker database...');
info('This will update operation metadata to include URLs for invalid_social_media_url errors.');
info('The script is safe to run while services are running.\n');

// Get the database path from the container's environment
const dbPath = getContainerEnvVar('gronka', 'GRONKA_DB_PATH');
if (!dbPath) {
  // Fallback to default production path
  const defaultPath = './data-prod/gronka.db';
  info(`⚠️  Could not get GRONKA_DB_PATH from container, using default: ${defaultPath}`);
  info('Running backfill script from host with database path...\n');
  execOrError(
    `GRONKA_DB_PATH=${defaultPath} node scripts/backfill-operation-urls.js`,
    'Failed to run backfill script'
  );
} else {
  info(`Using database path from container: ${dbPath}`);
  info('Running backfill script from host...\n');
  execOrError(
    `GRONKA_DB_PATH=${dbPath} node scripts/backfill-operation-urls.js`,
    'Failed to run backfill script'
  );
}

info('\n✓ Backfill complete!');
info('Refresh the Requests page in the webUI to see the updated URLs.');
