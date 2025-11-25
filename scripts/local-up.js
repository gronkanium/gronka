#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const pidFile = join(projectRoot, '.local-dev-pids.json');

// Load environment variables
dotenv.config({ path: join(projectRoot, '.env') });

// Check if services are already running
if (existsSync(pidFile)) {
  try {
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    const running = Object.entries(pids).some(([_name, pid]) => {
      try {
        // Check if process exists (works on both Windows and Unix)
        if (process.platform === 'win32') {
          execSync(`tasklist /FI "PID eq ${pid}" 2>nul | find /I "${pid}" >nul`, {
            stdio: 'ignore',
          });
          return true;
        } else {
          process.kill(pid, 0);
          return true;
        }
      } catch {
        return false;
      }
    });

    if (running) {
      console.error('error: local development services are already running');
      console.error('  use "npm run local:down" to stop them first');
      process.exit(1);
    }
  } catch {
    // PID file exists but is invalid, continue
  }
}

console.log('starting local development services...\n');

const pids = {};

// Function to start a process and track its PID
function startProcess(name, command, args, options = {}) {
  console.log(`starting ${name}...`);
  const proc = spawn(command, args, {
    stdio: 'inherit',
    cwd: projectRoot,
    shell: process.platform === 'win32',
    ...options,
  });

  proc.on('error', error => {
    console.error(`failed to start ${name}: ${error.message}`);
    cleanup();
    process.exit(1);
  });

  pids[name] = proc.pid;
  console.log(`  ${name} started (PID: ${proc.pid})\n`);
  return proc;
}

// Function to cleanup on error
function cleanup() {
  if (Object.keys(pids).length > 0) {
    console.log('\ncleaning up processes...');
    for (const [_name, pid] of Object.entries(pids)) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch {
        // Process may already be dead
      }
    }
  }
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // Ignore
    }
  }
}

// Handle termination signals
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

// Start cobalt docker container if not running
console.log('checking cobalt container...');
try {
  const cobaltStatus = execSync('docker ps --filter name=cobalt --format "{{.Names}}"', {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

  if (!cobaltStatus.includes('cobalt')) {
    console.log('starting cobalt container...');
    execSync('docker compose up -d cobalt', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    console.log('  cobalt container started\n');
  } else {
    console.log('  cobalt container already running\n');
  }
} catch (error) {
  console.warn('  warning: could not start cobalt container:', error.message);
  console.warn('  you may need to start it manually: docker compose up -d cobalt\n');
}

// Start Express server
startProcess('server', 'node', ['src/server.js']);

// Wait a moment for server to start
setTimeout(() => {}, 2000);

// Save PIDs to file
writeFileSync(pidFile, JSON.stringify(pids, null, 2));

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('local development services started');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  server: http://localhost:${process.env.SERVER_PORT || 3000}`);
console.log(`  webui:  http://localhost:${process.env.WEBUI_PORT || 3001}`);
console.log(`  cobalt: http://localhost:9000`);
console.log('');
console.log('use "npm run local:down" to stop all services');
console.log('use "npm run local:logs" to view logs');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Keep process alive
process.stdin.resume();
