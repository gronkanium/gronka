#!/usr/bin/env node

import { checkDockerDaemon, info, warn, error, execOrError, exec, sleep } from './utils.js';

const SERVICES_COMPOSE = 'docker-compose.services.yml';
const TIMEOUT = 120;

checkDockerDaemon();

info('Starting dependency services (postgres, cobalt, giflossy)...');

// Start containers using services-only compose file
execOrError(`docker compose -f ${SERVICES_COMPOSE} up -d`, 'Failed to start services');

// Wait a moment for containers to initialize
await sleep(2000);

// Verify containers started successfully
info('Verifying service status...');

const MAX_WAIT = TIMEOUT;
let elapsed = 0;

while (elapsed < MAX_WAIT) {
  // Check container status
  const psOutput = exec(
    `docker compose -f ${SERVICES_COMPOSE} ps --format "{{.Name}}: {{.Status}}"`,
    {
      throwOnError: false,
    }
  );

  const lines = psOutput.split('\n').filter(l => l.trim());
  const runningCount = lines.filter(
    l => l.toLowerCase().includes('up') || l.toLowerCase().includes('running')
  ).length;
  const exitedCount = lines.filter(l => l.toLowerCase().includes('exited')).length;

  if (exitedCount > 0) {
    const exitedList = lines.filter(l => l.toLowerCase().includes('exited'));
    error(`Some services exited: ${exitedList.join(', ')}`);
  }

  // Expected 3 services: postgres, cobalt, giflossy
  if (runningCount >= 3) {
    info('All services are running');

    // Wait for postgres health check
    info('Waiting for postgres to be healthy...');
    let postgresHealthy = false;
    let healthWait = 0;
    const healthTimeout = 60;

    while (healthWait < healthTimeout) {
      const healthOutput = exec(
        'docker inspect gronka-postgres --format "{{.State.Health.Status}}"',
        { throwOnError: false }
      ).trim();

      if (healthOutput === 'healthy') {
        postgresHealthy = true;
        break;
      }

      await sleep(2000);
      healthWait += 2;
    }

    if (postgresHealthy) {
      info('Postgres is healthy');
    } else {
      warn('Postgres health check timeout - it may still be starting');
    }

    console.log('');
    info('Services are ready! You can now run:');
    console.log('  npm run bot:test     # Start bot in TEST mode');
    console.log('  npm run bot:prod     # Start bot in PROD mode');
    console.log('');
    info('To stop services: npm run docker:services:down');
    process.exit(0);
  }

  await sleep(2000);
  elapsed += 2;
}

// Timeout - show status
warn('Timeout waiting for services. Current status:');
execOrError(`docker compose -f ${SERVICES_COMPOSE} ps`, 'Failed to show service status');

warn(
  'Services may still be starting. Check status with: docker compose -f docker-compose.services.yml ps'
);
