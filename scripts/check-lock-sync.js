#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const packageJsonPath = './package.json';
const packageLockPath = './package-lock.json';

// Check if files exist
if (!existsSync(packageJsonPath)) {
  console.error('Error: package.json not found');
  process.exit(1);
}

if (!existsSync(packageLockPath)) {
  console.error('Error: package-lock.json not found. Run "npm install" to create it.');
  process.exit(1);
}

try {
  // Try to run npm ci in dry-run mode to check if lock file is in sync
  // If it fails, the lock file is out of sync
  try {
    execSync('npm ci --dry-run', {
      stdio: 'pipe',
      cwd: process.cwd(),
    });
    console.log('✓ package-lock.json is in sync with package.json');
    process.exit(0);
  } catch {
    console.error('✗ package-lock.json is out of sync with package.json');
    console.error('\nTo fix this, run: npm install\n');
    process.exit(1);
  }
} catch (error) {
  console.error('Error checking lock file sync:', error.message);
  process.exit(1);
}
