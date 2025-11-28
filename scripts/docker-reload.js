#!/usr/bin/env node

import { checkDockerDaemon, info, execOrError, exec, getGitCommit, getTimestamp } from './utils.js';

checkDockerDaemon();

info('Reloading docker compose services...');

// Step 1: Stop and remove containers, and remove associated images
info('Stopping containers and removing images...');
execOrError(
  'docker compose down --rmi all --remove-orphans',
  'Failed to stop containers and remove images'
);

// Step 2: Prune containers and networks
info('Cleaning up unused containers and networks...');
exec('docker container prune -f', { stdio: 'ignore', throwOnError: false });
exec('docker network prune -f', { stdio: 'ignore', throwOnError: false });

// Step 3: Get git commit hash and build timestamp
const gitCommit = getGitCommit();
const buildTimestamp = getTimestamp();

// Set as environment variables for docker-compose.yml to use
process.env.GIT_COMMIT = gitCommit;
process.env.BUILD_TIMESTAMP = buildTimestamp.toString();

// Step 4: Rebuild images with build args
info('Rebuilding images (this will take a while)...');
execOrError('docker compose build --no-cache --pull', 'Failed to build docker images');

// Step 5: Start containers
info('Starting containers');
execOrError('docker compose up -d', 'Failed to start docker compose services');

info('Reload complete');
