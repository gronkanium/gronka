#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Get the rollup native package name for current platform
 */
function getRollupNativePackage() {
  const platform = process.platform;
  const arch = process.arch;

  // Map platform/arch to rollup package name
  if (platform === 'linux' && arch === 'x64') {
    return '@rollup/rollup-linux-x64-gnu';
  } else if (platform === 'linux' && arch === 'arm64') {
    return '@rollup/rollup-linux-arm64-gnu';
  } else if (platform === 'darwin' && arch === 'x64') {
    return '@rollup/rollup-darwin-x64';
  } else if (platform === 'darwin' && arch === 'arm64') {
    return '@rollup/rollup-darwin-arm64';
  } else if (platform === 'win32' && arch === 'x64') {
    return '@rollup/rollup-win32-x64-msvc';
  }

  return null;
}

/**
 * Try to install missing rollup native dependency
 */
function installRollupNative() {
  const packageName = getRollupNativePackage();

  if (!packageName) {
    console.warn(
      `Warning: Unknown platform ${process.platform}/${process.arch}, rollup native module may not be available`
    );
    return false;
  }

  try {
    console.log(`Installing rollup native module: ${packageName}`);
    execSync(`npm install ${packageName} --no-save --legacy-peer-deps`, {
      stdio: 'inherit',
    });
    return true;
  } catch (error) {
    console.warn(
      `Warning: Failed to install ${packageName}, build may still work: ${error.message}`
    );
    return false;
  }
}

/**
 * Main build function
 */
function build() {
  // Try to install rollup native module proactively
  // This handles the npm optional dependencies bug
  const packageName = getRollupNativePackage();
  if (packageName) {
    // Check if it exists in node_modules
    const packagePath = join(process.cwd(), 'node_modules', packageName);
    if (!existsSync(packagePath)) {
      console.log('Rollup native module not found, installing...');
      installRollupNative();
    }
  }

  // Run vite build
  try {
    console.log('Building webui...');
    execSync('vite build', {
      stdio: 'inherit',
    });
    console.log('Build completed successfully');
  } catch (error) {
    // If build fails with rollup error, try installing the native module
    const errorMessage = error.message || error.toString();
    if (
      errorMessage.includes('rollup') &&
      (errorMessage.includes('Cannot find module') || errorMessage.includes('MODULE_NOT_FOUND'))
    ) {
      console.log('Build failed due to missing rollup native module, attempting to install...');
      if (installRollupNative()) {
        // Retry build after installing
        console.log('Retrying build...');
        try {
          execSync('vite build', {
            stdio: 'inherit',
          });
          console.log('Build completed successfully');
          return;
        } catch (_retryError) {
          console.error('Build failed after installing rollup native module');
          process.exit(1);
        }
      }
    }
    console.error('Build failed');
    process.exit(1);
  }
}

build();
