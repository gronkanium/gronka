#!/usr/bin/env node

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const pidFile = join(projectRoot, '.local-dev-pids.json');

// Check if services are running
if (!existsSync(pidFile)) {
  console.error('error: local development services are not running');
  console.error('  use "npm run local:up" to start them first');
  process.exit(1);
}

let pids;
try {
  pids = JSON.parse(readFileSync(pidFile, 'utf8'));
} catch (error) {
  console.error('error: could not read PID file:', error.message);
  process.exit(1);
}

console.log('streaming logs from local development services...');
console.log('press Ctrl+C to stop\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// On Windows, we can't easily tail process output, so just show a message
if (process.platform === 'win32') {
  console.log('note: on Windows, logs are shown in the terminal where services were started');
  console.log('running services:');
  for (const [name, pid] of Object.entries(pids)) {
    console.log(`  ${name} (PID: ${pid})`);
  }
  console.log('\nuse the terminal where you ran "npm run local:up" to see logs');
  process.exit(0);
}

// On Unix, we can try to show logs from log files if they exist
const logDir = join(projectRoot, 'logs');
const logFiles = ['bot.log', 'server.log'];

let logProcesses = [];

for (const logFile of logFiles) {
  const logPath = join(logDir, logFile);
  if (existsSync(logPath)) {
    const tail = spawn('tail', ['-f', logPath], {
      stdio: 'inherit',
    });
    logProcesses.push(tail);
  }
}

// If no log files, just show running processes
if (logProcesses.length === 0) {
  console.log('running services:');
  for (const [name, pid] of Object.entries(pids)) {
    console.log(`  ${name} (PID: ${pid})`);
  }
  console.log(
    '\nnote: log files not found, logs are shown in the terminal where services were started'
  );
}

// Handle termination
process.on('SIGINT', () => {
  for (const proc of logProcesses) {
    proc.kill('SIGTERM');
  }
  process.exit(0);
});
