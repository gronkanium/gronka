#!/usr/bin/env node

import {
  checkDockerDaemon,
  info,
  warn,
  section,
  exec,
  getGitCommit,
  isContainerRunning,
  getContainerEnvVar,
} from './utils.js';

checkDockerDaemon();

section('Checking Docker Containers Status');

// Get current git commit hash
const currentCommit = getGitCommit();
const currentCommitShort = getGitCommit(true);

info(`Current repository commit: ${currentCommitShort || 'unknown'}`);

// Check if containers are running
const containers = ['gronka'];
let allUpToDate = true;

for (const containerName of containers) {
  console.log('');
  section(`Checking ${containerName}`);

  if (!isContainerRunning(containerName)) {
    warn(`${containerName} is not running`);
    allUpToDate = false;
    continue;
  }

  info(`${containerName} is running`);

  // Try to get commit hash from container environment
  let containerCommit = getContainerEnvVar(containerName, 'GIT_COMMIT');

  // Try to get build timestamp
  const buildTimestamp = getContainerEnvVar(containerName, 'BUILD_TIMESTAMP');

  if (containerCommit && containerCommit !== 'unknown' && containerCommit !== '') {
    const containerCommitShort = containerCommit.substring(0, 7);
    info(`Container commit: ${containerCommitShort}`);

    if (containerCommit === currentCommit) {
      info(`${containerName} is running the latest code ✓`);
    } else {
      warn(
        `${containerName} is running different code (${containerCommitShort} vs ${currentCommitShort})`
      );
      allUpToDate = false;
    }
  } else {
    warn(`Could not determine commit hash for ${containerName}`);
    if (buildTimestamp && buildTimestamp !== 'unknown' && buildTimestamp !== '') {
      info(`Build timestamp: ${buildTimestamp}`);
    }
    allUpToDate = false;
  }

  // Show container image info
  try {
    const image = exec(`docker inspect ${containerName} --format='{{.Config.Image}}'`, {
      throwOnError: false,
    }).trim();
    const created = exec(`docker inspect ${containerName} --format='{{.Created}}'`, {
      throwOnError: false,
    }).trim();
    info(`Image: ${image || 'unknown'}`);
    if (created && created !== 'unknown') {
      info(`Container created: ${created}`);
    }
  } catch {
    // Ignore
  }
}

console.log('');
section('Summary');

if (allUpToDate) {
  info('All containers are running and appear to be up to date');
  process.exit(0);
} else {
  warn('Some containers may not be running the latest code');
  info('To update, run: npm run docker:reload');
  process.exit(1);
}
