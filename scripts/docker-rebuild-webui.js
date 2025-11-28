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

// Install devDependencies inside the container (needed for building webui)
info('Installing devDependencies in container...');
execOrError(
  'docker compose exec -T app npm install --include=dev',
  'Failed to install devDependencies in container'
);

// Build webui inside the container
info('Building webui inside container...');
execOrError(
  'docker compose exec -T app npm run build:webui',
  'Failed to build webui inside container'
);

info('WebUI rebuild complete. The webui should now reflect the latest changes.');
info('Note: Browser caching may require a hard refresh (Ctrl+F5) to see changes.');
