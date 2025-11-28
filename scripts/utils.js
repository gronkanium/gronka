#!/usr/bin/env node

import { execSync } from 'child_process';

// ANSI color codes (using hex escapes instead of octal)
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m'; // No Color

/**
 * Print info message in green
 */
export function info(message) {
  console.log(`${GREEN}Info:${NC} ${message}`);
}

/**
 * Print warning message in yellow
 */
export function warn(message) {
  console.log(`${YELLOW}Warning:${NC} ${message}`);
}

/**
 * Print error message in red and exit
 */
export function error(message) {
  console.error(`${RED}Error:${NC} ${message}`);
  process.exit(1);
}

/**
 * Print section header in blue
 */
export function section(title) {
  console.log(`${BLUE}=== ${title} ===${NC}`);
}

/**
 * Check if Docker daemon is available
 */
export function checkDockerDaemon() {
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    error('Docker daemon is not running or not accessible');
  }
}

/**
 * Execute a command and return the output
 * @param {string} command - Command to execute
 * @param {object} options - Options for execSync
 * @returns {string} Command output
 */
export function exec(command, options = {}) {
  try {
    const { throwOnError: _throwOnError, ...execOptions } = options;
    return execSync(command, {
      encoding: 'utf8',
      stdio: execOptions.stdio || 'pipe',
      ...execOptions,
    });
  } catch (err) {
    if (options.throwOnError !== false) {
      throw err;
    }
    return '';
  }
}

/**
 * Execute a command with error handling
 * @param {string} command - Command to execute
 * @param {string} errorMessage - Error message if command fails
 * @param {object} options - Options for execSync
 */
export function execOrError(command, errorMessage, options = {}) {
  try {
    execSync(command, {
      stdio: 'inherit',
      ...options,
    });
  } catch {
    error(errorMessage);
  }
}

/**
 * Get git commit hash
 * @param {boolean} short - Return short hash (7 chars)
 * @returns {string} Commit hash or empty string
 */
export function getGitCommit(short = false) {
  try {
    const command = short ? 'git rev-parse --short HEAD' : 'git rev-parse HEAD';
    return exec(command).trim();
  } catch {
    return '';
  }
}

/**
 * Get current timestamp in seconds
 * @returns {number} Unix timestamp
 */
export function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Check if a container is running
 * @param {string} containerName - Name of the container
 * @returns {boolean} True if running
 */
export function isContainerRunning(containerName) {
  try {
    const output = exec(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`);
    return output
      .trim()
      .split('\n')
      .some(name => name === containerName);
  } catch {
    return false;
  }
}

/**
 * Get container status counts
 * @returns {object} Object with running, exited, restarting counts
 */
export function getContainerStatus() {
  try {
    const output = exec('docker compose ps', { throwOnError: false });

    if (!output || output.trim() === '') {
      return { running: 0, exited: 0, restarting: 0 };
    }

    const lines = output.split('\n');
    let running = 0;
    let exited = 0;
    let restarting = 0;

    for (const line of lines) {
      if (line.toLowerCase().includes('running')) {
        running++;
      } else if (line.toLowerCase().includes('exited')) {
        exited++;
      } else if (line.toLowerCase().includes('restarting')) {
        restarting++;
      }
    }

    return { running, exited, restarting };
  } catch {
    return { running: 0, exited: 0, restarting: 0 };
  }
}

/**
 * Get list of container names from docker compose
 * @returns {string[]} Array of container names
 */
export function getContainerNames() {
  try {
    const output = exec('docker compose ps --format "{{.Name}}"', { throwOnError: false });
    return output
      .trim()
      .split('\n')
      .filter(name => name.trim() !== '');
  } catch {
    return [];
  }
}

/**
 * Get container environment variable value
 * @param {string} containerName - Name of the container
 * @param {string} envVar - Environment variable name
 * @returns {string} Value or empty string
 */
export function getContainerEnvVar(containerName, envVar) {
  try {
    // Try exec first
    const execOutput = exec(`docker exec ${containerName} sh -c "echo $${envVar}"`, {
      throwOnError: false,
    });
    const value = execOutput.trim().replace(/\r\n/g, '').replace(/\n/g, '');
    if (value && value !== '') {
      return value;
    }

    // Fallback to inspect
    const inspectOutput = exec(
      `docker inspect ${containerName} --format='{{range .Config.Env}}{{println .}}{{end}}'`,
      { throwOnError: false }
    );
    const lines = inspectOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith(`${envVar}=`)) {
        return line.substring(envVar.length + 1).trim();
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Check if container has health check
 * @param {string} containerName - Name of the container
 * @returns {boolean} True if has health check
 */
export function hasHealthCheck(containerName) {
  try {
    const output = exec(`docker inspect ${containerName} --format '{{.State.Health}}'`, {
      throwOnError: false,
    });
    return output.includes('Status');
  } catch {
    return false;
  }
}

/**
 * Get container health status
 * @param {string} containerName - Name of the container
 * @returns {string} Health status or empty string
 */
export function getContainerHealth(containerName) {
  try {
    return exec(`docker inspect ${containerName} --format '{{.State.Health.Status}}'`, {
      throwOnError: false,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after sleep
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
