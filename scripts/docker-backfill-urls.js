#!/usr/bin/env node

import { checkDockerDaemon, info, execOrError, getContainerEnvVar } from './utils.js';

checkDockerDaemon();

info('Running backfill script for Docker database...');
info('This will update operation metadata to include URLs for invalid_social_media_url errors.');
info('The script is safe to run while services are running.\n');

// Get PostgreSQL database name from the container's environment
const postgresDb = getContainerEnvVar('gronka', 'POSTGRES_DB') || 'gronka';
const postgresHost = getContainerEnvVar('gronka', 'POSTGRES_HOST') || 'postgres';

info(`Using PostgreSQL database: ${postgresDb} on ${postgresHost}`);
info('Running backfill script from host...\n');

// Pass PostgreSQL connection info to backfill script
execOrError(
  `POSTGRES_DB=${postgresDb} POSTGRES_HOST=${postgresHost} node scripts/backfill-operation-urls.js`,
  'Failed to run backfill script'
);

info('\n✓ Backfill complete!');
info('Refresh the Requests page in the webUI to see the updated URLs.');
