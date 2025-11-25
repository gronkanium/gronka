#!/usr/bin/env node

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('restarting local development services...\n');

// Stop services
try {
  execSync('node scripts/local-down.js', {
    stdio: 'inherit',
    cwd: projectRoot,
  });
} catch {
  // Ignore errors from stop
}

// Wait a moment
setTimeout(() => {
  // Start services
  try {
    execSync('node scripts/local-up.js', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  } catch (error) {
    console.error('error: failed to restart services:', error.message);
    process.exit(1);
  }
}, 1000);
