#!/usr/bin/env node

import { spawn } from 'child_process';
import {
  checkDockerDaemon,
  info,
  warn,
  error,
  execOrError,
  exec,
  getGitCommit,
  getTimestamp,
} from './utils.js';

/**
 * Check if Docker Desktop is running (Windows/WSL2 specific)
 * @returns {boolean} True if Docker Desktop appears to be running
 */
function checkDockerDesktop() {
  try {
    // Check if docker context is set to desktop
    const context = exec('docker context show', { throwOnError: false }).trim();
    if (context.includes('desktop')) {
      return true;
    }
    // Try to get Docker version info which requires daemon
    exec('docker version --format "{{.Server.Version}}"', { throwOnError: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if error is a credential helper error
 * @param {string} errorOutput - Error output from command
 * @returns {boolean} True if credential error detected
 */
function isCredentialError(errorOutput) {
  const credentialErrorIndicators = [
    'error getting credentials',
    'logon session does not exist',
    'credential helper',
    'authentication required',
  ];
  const lowerOutput = errorOutput.toLowerCase();
  return credentialErrorIndicators.some(indicator => lowerOutput.includes(indicator));
}

/**
 * Build Docker images with fallback strategy
 * @param {boolean} usePull - Whether to use --pull flag
 * @returns {Promise<{success: boolean, error?: string}>} Build result
 */
function buildImages(usePull = true) {
  return new Promise(resolve => {
    const pullFlag = usePull ? '--pull' : '';
    const buildCommand = `docker compose build --no-cache ${pullFlag}`.trim();

    if (usePull) {
      info('Using --pull flag to fetch latest base images');
    } else {
      warn('Building without --pull flag (using cached base images)');
    }

    let stderrOutput = '';

    const child = spawn(buildCommand, {
      stdio: ['inherit', 'inherit', 'pipe'], // stdin and stdout inherited, stderr piped
      shell: true,
    });

    // Capture stderr for error detection
    child.stderr.on('data', data => {
      stderrOutput += data.toString();
      // Also display stderr to user in real-time
      process.stderr.write(data);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorOutput = stderrOutput || `Build failed with exit code ${code}`;
        resolve({ success: false, error: errorOutput });
      }
    });

    child.on('error', err => {
      resolve({
        success: false,
        error: err.message || 'Unknown build error',
      });
    });
  });
}

/**
 * Check if Docker images exist locally
 * @param {string[]} images - Array of image names to check
 * @returns {boolean} True if all images exist
 */
function imagesExistLocally(images) {
  for (const image of images) {
    try {
      const output = exec(`docker image inspect ${image}`, {
        stdio: 'pipe',
        throwOnError: false,
      });
      // docker image inspect returns JSON if image exists, empty or error if not
      if (!output || output.trim() === '' || output.includes('Error:')) {
        return false; // Image doesn't exist
      }
      // Check if output is valid JSON (basic check)
      if (!output.trim().startsWith('[') && !output.trim().startsWith('{')) {
        return false;
      }
    } catch {
      return false; // At least one image doesn't exist
    }
  }
  return true; // All images exist
}

/**
 * Start Docker containers
 * @returns {Promise<{success: boolean, error?: string}>} Start result
 */
function startContainers() {
  return new Promise(resolve => {
    // docker compose up -d will use existing images if they're present
    // It only tries to pull if images are missing
    const upCommand = 'docker compose up -d';

    let stderrOutput = '';

    const child = spawn(upCommand, {
      stdio: ['inherit', 'inherit', 'pipe'], // stdin and stdout inherited, stderr piped
      shell: true,
    });

    // Capture stderr for error detection
    child.stderr.on('data', data => {
      stderrOutput += data.toString();
      // Also display stderr to user in real-time
      process.stderr.write(data);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorOutput = stderrOutput || `Failed to start containers with exit code ${code}`;
        resolve({ success: false, error: errorOutput });
      }
    });

    child.on('error', err => {
      resolve({
        success: false,
        error: err.message || 'Unknown error starting containers',
      });
    });
  });
}

// Enhanced Docker daemon check
checkDockerDaemon();

// Additional diagnostic checks
info('Running diagnostic checks...');

// Check Docker Desktop status (helpful for Windows/WSL2 users)
if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
  if (!checkDockerDesktop()) {
    warn('Docker Desktop may not be running properly');
    warn('If you are on Windows/WSL2, ensure Docker Desktop is started');
  }
}

// Verify Docker daemon is accessible with a simple command
try {
  exec('docker info --format "{{.ServerVersion}}"', { stdio: 'ignore' });
  info('Docker daemon is accessible');
} catch {
  error('Docker daemon is not accessible. Please ensure Docker Desktop is running.');
}

info('Reloading docker compose services...');

// Step 1: Stop and remove containers, and remove associated images
info('Stopping containers and removing images...');
execOrError(
  'docker compose down --rmi all --remove-orphans',
  'Failed to stop containers and remove images'
);

// Step 2: Prune containers and networks
info('Cleaning up unused containers and networks...');
exec('docker container prune -f', { stdio: 'ignore', throwOnError: false });
exec('docker network prune -f', { stdio: 'ignore', throwOnError: false });

// Step 3: Get git commit hash and build timestamp
const gitCommit = getGitCommit();
const buildTimestamp = getTimestamp();

// Set as environment variables for docker-compose.yml to use
process.env.GIT_COMMIT = gitCommit;
process.env.BUILD_TIMESTAMP = buildTimestamp.toString();

// Step 4: Rebuild images with build args and credential error handling
info('Rebuilding images (this will take a while)...');

(async () => {
  try {
    let buildResult = await buildImages(true); // Try with --pull first

    if (!buildResult.success && isCredentialError(buildResult.error)) {
      warn('Credential helper error detected. This is common on Windows/WSL2.');
      warn('Troubleshooting steps:');
      warn('  1. Restart Docker Desktop');
      warn('  2. Check Docker Desktop settings > Resources > WSL Integration');
      warn('  3. Try: docker logout && docker login');
      warn('  4. Clear credentials: Remove ~/.docker/config.json credential helper section');
      warn('');
      warn('Attempting fallback: building without --pull flag (using cached images)...');
      warn('');

      // Fallback: try building without --pull
      buildResult = await buildImages(false);
      if (buildResult.success) {
        warn('Build succeeded using cached base images');
        warn('Note: Base images may not be the latest version');
      } else {
        error(
          `Failed to build docker images even with fallback strategy.\nError: ${buildResult.error}`
        );
      }
    } else if (!buildResult.success) {
      error(`Failed to build docker images.\nError: ${buildResult.error}`);
    }

    // Step 5: Start containers with credential error handling
    info('Starting containers');
    let startResult = await startContainers(); // Try starting containers

    if (!startResult.success && isCredentialError(startResult.error)) {
      warn('Credential helper error detected when starting containers.');
      warn('This usually happens when docker compose tries to pull external images.');
      warn('Checking if required images exist locally...');

      // Check if the external images exist locally
      const externalImages = [
        'ghcr.io/imputnet/cobalt:11',
        'dylanninin/giflossy:latest',
        'ghcr.io/containrrr/watchtower:latest',
      ];

      const allImagesExist = imagesExistLocally(externalImages);

      if (allImagesExist) {
        warn('All required images found locally. Retrying container startup...');
        warn('Note: docker compose should use existing images without pulling');
        warn('');

        // Retry - docker compose should use existing images without trying to pull
        startResult = await startContainers();
        if (startResult.success) {
          warn('Containers started using existing local images');
        } else {
          // If it still fails, the error might not be credential-related on retry
          if (isCredentialError(startResult.error)) {
            error(
              `Failed to start containers even with existing images.\nError: ${startResult.error}\n\nTry restarting Docker Desktop.`
            );
          } else {
            error(`Failed to start containers.\nError: ${startResult.error}`);
          }
        }
      } else {
        warn('Some required images are missing locally.');
        warn('Troubleshooting steps:');
        warn('  1. Restart Docker Desktop');
        warn('  2. Manually pull images:');
        warn('     docker pull ghcr.io/imputnet/cobalt:11');
        warn('     docker pull dylanninin/giflossy:latest');
        warn('     docker pull ghcr.io/containrrr/watchtower:latest');
        warn('  3. Try: docker logout && docker login');
        warn('  4. Clear credentials: Remove ~/.docker/config.json credential helper section');
        error(
          `Cannot start containers - images need to be pulled but credential helper is failing.\nError: ${startResult.error}`
        );
      }
    } else if (!startResult.success) {
      error(`Failed to start docker compose services.\nError: ${startResult.error}`);
    }

    info('Reload complete');
  } catch (err) {
    error(`Unexpected error: ${err.message}`);
  }
})();
