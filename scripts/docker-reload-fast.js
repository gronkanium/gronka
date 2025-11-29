#!/usr/bin/env node

import {
  checkDockerDaemon,
  info,
  warn,
  execOrError,
  exec,
  getGitCommit,
  getTimestamp,
  sleep,
} from './utils.js';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

checkDockerDaemon();

// Wrap async code in async function
(async () => {
  info('Fast reloading docker compose services (using build cache)...');

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

  // Step 2.5: Wait a moment for Docker Desktop to clean up mount points (WSL2 fix)
  info('Waiting for Docker Desktop to clean up mount points...');
  await sleep(2000);

  // Step 2.6: Ensure local directories exist (prevents WSL2 mount errors)
  info('Ensuring local directories exist...');
  const requiredDirs = ['data-test', 'data-prod', 'temp', 'logs'];
  for (const dir of requiredDirs) {
    const dirPath = join(projectRoot, dir);
    if (!existsSync(dirPath)) {
      try {
        mkdirSync(dirPath, { recursive: true });
        info(`  Created directory: ${dir}`);
      } catch (error) {
        warn(`  Warning: Could not create directory ${dir}: ${error.message}`);
      }
    }
  }

  // Step 3: Get git commit hash and build timestamp
  const gitCommit = getGitCommit();
  const buildTimestamp = getTimestamp();

  // Set as environment variables for docker-compose.yml to use
  process.env.GIT_COMMIT = gitCommit;
  process.env.BUILD_TIMESTAMP = buildTimestamp.toString();

  // Step 4: Rebuild images with build args (using cache for speed)
  // Enable BuildKit for faster context scanning and better caching
  process.env.DOCKER_BUILDKIT = '1';
  process.env.COMPOSE_DOCKER_CLI_BUILD = '1';

  info('Rebuilding images with cache (this should be much faster)...');
  const buildStartTime = Date.now();
  execOrError('docker compose build', 'Failed to build docker images');
  const buildEndTime = Date.now();
  const buildDuration = ((buildEndTime - buildStartTime) / 1000).toFixed(2);

  // Show build timing if DEBUG is enabled or if build took longer than 30 seconds
  if (process.env.DEBUG || buildDuration > 30) {
    info(`Build completed in ${buildDuration}s (context scanning + transfer + build)`);
  }

  // Step 5: Start containers with retry logic for WSL2 mount errors
  info('Starting containers');
  let retries = 3;

  while (retries > 0) {
    try {
      execSync('docker compose up -d', {
        stdio: 'inherit',
        cwd: projectRoot,
      });
      // Success - break out of retry loop
      break;
    } catch (error) {
      const errorMessage = error.message || error.toString();

      // Check if it's a mount error (WSL2 issue)
      if (
        errorMessage.includes('error while creating mount source path') ||
        errorMessage.includes('file exists') ||
        errorMessage.includes('docker-desktop-bind-mounts')
      ) {
        retries--;
        if (retries > 0) {
          warn(
            `Mount error detected (WSL2 issue). Retrying in 3 seconds... (${retries} attempts remaining)`
          );
          await sleep(3000);

          // Try to clean up by running down again
          warn('Attempting to clean up stale mounts...');
          exec('docker compose down', { stdio: 'ignore', throwOnError: false });
          await sleep(2000);
        } else {
          warn(
            'Failed to start containers after retries. This is a known WSL2/Docker Desktop issue.'
          );
          warn('Troubleshooting steps:');
          warn('  1. Restart Docker Desktop');
          warn('  2. Wait 10-15 seconds after restart');
          warn('  3. Try running: docker compose down');
          warn('  4. Wait a few seconds, then try: docker compose up -d');
          warn('  5. If still failing, restart WSL2: wsl --shutdown (from Windows PowerShell)');
          throw error;
        }
      } else {
        // Not a mount error, fail immediately
        throw error;
      }
    }
  }

  info('Fast reload complete');
})().catch(error => {
  warn(`Error during reload: ${error.message}`);
  process.exit(1);
});
