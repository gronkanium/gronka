#!/usr/bin/env node

import {
  checkDockerDaemon,
  info,
  warn,
  error,
  execOrError,
  exec,
  getContainerStatus,
  getContainerNames,
  hasHealthCheck,
  getContainerHealth,
  sleep,
} from './utils.js';

const TIMEOUT = 120;

checkDockerDaemon();

info('Starting docker compose services');

// Start containers
execOrError('docker compose up -d', 'Failed to start docker compose services');

// Wait a moment for containers to initialize
await sleep(2000);

// Verify containers started successfully
info('Verifying container status...');

const MAX_WAIT = TIMEOUT;
let elapsed = 0;

while (elapsed < MAX_WAIT) {
  const status = getContainerStatus();
  const { running, exited, restarting } = status;

  // Check for exited containers (failed)
  if (exited > 0) {
    const exitedContainers = exec('docker compose ps --format "{{.Name}}: {{.Status}}"', {
      throwOnError: false,
    });
    const lines = exitedContainers.split('\n');
    const exitedList = lines.filter(line => line.toLowerCase().includes('exited'));
    if (exitedList.length > 0) {
      error(`Some containers exited: ${exitedList.join(', ')}`);
    }
  }

  // Count total services
  const containerNames = getContainerNames();
  const totalServices = containerNames.length;

  // If all running and none restarting/exited, we're good
  if (totalServices > 0 && running >= totalServices && restarting === 0 && exited === 0) {
    info('All containers are running');

    // Check for health checks and wait for them
    let hasHealthCheckFlag = false;
    for (const name of containerNames) {
      if (hasHealthCheck(name)) {
        hasHealthCheckFlag = true;
        break;
      }
    }

    if (hasHealthCheckFlag) {
      info('Waiting for health checks to pass...');
      await sleep(10000);

      // Check final health status
      let unhealthy = 0;
      for (const name of containerNames) {
        const health = getContainerHealth(name);
        if (health === 'unhealthy') {
          unhealthy++;
        }
      }

      if (unhealthy > 0) {
        warn('Some containers are unhealthy. Check logs with: npm run docker:logs');
      } else {
        info('All health checks passed');
      }
    }

    process.exit(0);
  }

  await sleep(2000);
  elapsed += 2;
}

// Timeout - show status
warn('Timeout waiting for containers. Current status:');
execOrError('docker compose ps', 'Failed to show container status');

// Check if any failed
const finalStatus = getContainerStatus();
if (finalStatus.exited > 0) {
  error('Some containers failed to start. Check logs with: npm run docker:logs');
}

warn('Containers may still be starting. Check status with: docker compose ps');
