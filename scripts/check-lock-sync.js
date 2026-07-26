#!/usr/bin/env bun

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const packageJsonPath = './package.json';
const lockPath = './bun.lock';

// Check if files exist
if (!existsSync(packageJsonPath)) {
  console.error('Error: package.json not found');
  process.exit(1);
}

if (!existsSync(lockPath)) {
  console.error('Error: bun.lock not found. Run "bun install" to create it.');
  process.exit(1);
}

// `bun install --frozen-lockfile --dry-run` resolves the full tree against the lockfile and
// fails if package.json asks for anything the lockfile does not already pin, without touching
// node_modules. That is the bun equivalent of the old `npm ci --dry-run` check.
try {
  execSync('bun install --frozen-lockfile --dry-run', {
    stdio: 'pipe',
    cwd: process.cwd(),
  });
  console.log('✓ bun.lock is in sync with package.json');
  process.exit(0);
} catch (error) {
  console.error('✗ bun.lock is out of sync with package.json');
  if (error.stderr) console.error(error.stderr.toString().trim());
  console.error('\nTo fix this, run: bun run fix:deps');
  console.error('Or manually run: bun install\n');
  process.exit(1);
}
