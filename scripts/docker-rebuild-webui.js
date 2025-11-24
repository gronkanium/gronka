#!/usr/bin/env node

import { execSync } from 'child_process';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWindows = platform() === 'win32';

if (isWindows) {
  try {
    execSync('powershell -File scripts/docker-rebuild-webui.ps1', {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
    });
  } catch {
    process.exit(1);
  }
} else {
  try {
    execSync('bash scripts/docker-rebuild-webui.sh', {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
    });
  } catch {
    process.exit(1);
  }
}
