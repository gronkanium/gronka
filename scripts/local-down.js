#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const pidFile = join(projectRoot, '.local-dev-pids.json');

console.log('stopping local development services...\n');

// Read PIDs from file
if (!existsSync(pidFile)) {
  console.log('no running services found (no PID file)');
  process.exit(0);
}

let pids;
try {
  pids = JSON.parse(readFileSync(pidFile, 'utf8'));
} catch (error) {
  console.error('error: could not read PID file:', error.message);
  unlinkSync(pidFile);
  process.exit(1);
}

// Stop all processes
let stopped = 0;
for (const [name, pid] of Object.entries(pids)) {
  try {
    console.log(`stopping ${name} (PID: ${pid})...`);
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore' });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
        // Wait a bit, then force kill if still running
        setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already dead
          }
        }, 2000);
      } catch {
        // Process may already be dead
      }
    }
    console.log(`  ${name} stopped`);
    stopped++;
  } catch (error) {
    console.warn(`  warning: could not stop ${name}: ${error.message}`);
  }
}

// Remove PID file
try {
  unlinkSync(pidFile);
} catch {
  // Ignore if file doesn't exist
}

// Stop cobalt container (optional - comment out if you want to keep it running)
console.log('\nstopping cobalt container...');
try {
  execSync('docker compose stop cobalt', {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  console.log('  cobalt container stopped');
} catch (error) {
  console.warn('  warning: could not stop cobalt container:', error.message);
}

console.log(`\nstopped ${stopped} service(s)`);
console.log('local development services stopped');
