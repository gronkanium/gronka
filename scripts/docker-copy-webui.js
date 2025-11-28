#!/usr/bin/env node

import { checkDockerDaemon, info, error, execOrError, isContainerRunning } from './utils.js';

checkDockerDaemon();

// Check if app container is running
const containerName = 'gronka';
if (!isContainerRunning(containerName)) {
  error(
    `Container ${containerName} is not running. Please start it first with: docker compose up -d`
  );
}

// Build webui locally
info('Building webui locally...');
execOrError('npm run build:webui', 'Failed to build webui locally');

// Copy built files to container
info('Copying built files to container...');
execOrError(
  `docker cp src/public/. ${containerName}:/app/src/public/`,
  'Failed to copy files to container'
);

info('Files copied successfully. The webui should now reflect the latest changes.');
