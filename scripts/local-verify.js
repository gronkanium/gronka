#!/usr/bin/env node

import { execSync } from 'child_process';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const pidFile = join(projectRoot, '.local-dev-pids.json');

console.log('verifying local development services...\n');

let allGood = true;

// Check if PID file exists
if (!existsSync(pidFile)) {
  console.error('✗ services are not running (no PID file found)');
  console.error('  use "npm run local:up" to start services');
  process.exit(1);
}

// Check processes
let pids;
try {
  pids = JSON.parse(readFileSync(pidFile, 'utf8'));
} catch (error) {
  console.error('✗ could not read PID file:', error.message);
  process.exit(1);
}

// Verify processes are running
for (const [name, pid] of Object.entries(pids)) {
  try {
    if (process.platform === 'win32') {
      execSync(`tasklist /FI "PID eq ${pid}" 2>nul | find /I "${pid}" >nul`, {
        stdio: 'ignore',
      });
      console.log(`✓ ${name} is running (PID: ${pid})`);
    } else {
      process.kill(pid, 0);
      console.log(`✓ ${name} is running (PID: ${pid})`);
    }
  } catch {
    console.error(`✗ ${name} is not running (PID: ${pid} not found)`);
    allGood = false;
  }
}

// Check server health endpoint
const serverPort = process.env.SERVER_PORT || 3000;
console.log(`\nchecking server health (http://localhost:${serverPort}/health)...`);

const healthCheck = new Promise((resolve, reject) => {
  const req = http.get(`http://localhost:${serverPort}/health`, res => {
    if (res.statusCode === 200) {
      resolve(true);
    } else {
      reject(new Error(`unexpected status code: ${res.statusCode}`));
    }
  });

  req.on('error', reject);
  req.setTimeout(5000, () => {
    req.destroy();
    reject(new Error('timeout'));
  });
});

(async () => {
  try {
    await healthCheck;
    console.log('✓ server health check passed');
  } catch (error) {
    console.error(`✗ server health check failed: ${error.message}`);
    allGood = false;
  }

  // Check cobalt container
  console.log('\nchecking cobalt container...');
  try {
    const cobaltStatus = execSync('docker ps --filter name=cobalt --format "{{.Names}}"', {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    if (cobaltStatus.includes('cobalt')) {
      console.log('✓ cobalt container is running');
    } else {
      console.error('✗ cobalt container is not running');
      allGood = false;
    }
  } catch (error) {
    console.warn('⚠ could not check cobalt container:', error.message);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allGood) {
    console.log('✓ all services are running and healthy');
    process.exit(0);
  } else {
    console.error('✗ some services are not running or unhealthy');
    process.exit(1);
  }
})();
