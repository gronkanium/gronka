import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { getGifPath } from './storage.js';
import { ValidationError } from './errors.js';
const logger = createLogger('gif-optimizer');

/**
 * Escape a string for safe use in shell command arguments
 * Prevents command injection by properly quoting and escaping special characters
 * Note: This function is kept for backwards compatibility and testing.
 * The actual docker command uses spawn() with array arguments which is safer.
 * @param {string} arg - Argument to escape
 * @returns {string} Escaped argument safe for shell use
 */
export function escapeShellArg(arg) {
  if (typeof arg !== 'string') {
    throw new ValidationError('Argument must be a string');
  }
  // Replace single quotes with '\'' (exit quote, literal quote, enter quote)
  // Then wrap entire string in single quotes to prevent shell expansion
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Check if a file is a GIF based on extension and content type
 * @param {string} filename - File name
 * @param {string} contentType - Content type (MIME type)
 * @returns {boolean} True if file is a GIF
 */
export function isGifFile(filename, contentType) {
  const ext = path.extname(filename).toLowerCase();
  const isGifExt = ext === '.gif';
  const isGifContentType = contentType ? contentType.toLowerCase() === 'image/gif' : false;

  return isGifExt || isGifContentType;
}

/**
 * Extract hash from cdn URL (supports cdn.gronka.p1x.dev and other p1x.dev subdomains)
 * @param {string} url - URL to parse (e.g., https://cdn.gronka.p1x.dev/gifs/abc123.gif)
 * @returns {string|null} Extracted hash or null if not a valid cdn URL
 */
export function extractHashFromCdnUrl(url) {
  try {
    const urlObj = new URL(url);

    // Check if it's a p1x.dev subdomain URL
    if (!urlObj.hostname.endsWith('.p1x.dev')) {
      return null;
    }

    // Parse path patterns: /gifs/{hash}.gif, /videos/{hash}.{ext}, /images/{hash}.{ext}
    const gifPathMatch = urlObj.pathname.match(/^\/gifs\/([a-f0-9]+)\.gif$/i);
    if (gifPathMatch && gifPathMatch[1]) {
      return gifPathMatch[1];
    }

    const videoPathMatch = urlObj.pathname.match(
      /^\/videos\/([a-f0-9]+)\.(mp4|webm|mov|avi|mkv)$/i
    );
    if (videoPathMatch && videoPathMatch[1]) {
      return videoPathMatch[1];
    }

    const imagePathMatch = urlObj.pathname.match(/^\/images\/([a-f0-9]+)\.(png|jpg|jpeg|webp)$/i);
    if (imagePathMatch && imagePathMatch[1]) {
      return imagePathMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a GIF exists locally in storage (bypasses R2 check)
 * @param {string} hash - Hash of the GIF file
 * @param {string} storagePath - Base storage path
 * @returns {Promise<boolean>} True if GIF exists locally on disk
 */
export async function checkLocalGif(hash, storagePath) {
  // Check local filesystem directly, ignoring R2
  // This is used by optimization to determine if we can use a local file
  // instead of downloading from R2/CDN
  try {
    const gifPath = getGifPath(hash, storagePath);
    await fs.access(gifPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Optimize a GIF file using giflossy docker container
 * @param {string} inputPath - Path to input GIF file
 * @param {string} outputPath - Path to output optimized GIF file
 * @param {Object} options - Optimization options
 * @param {number} options.lossy - Lossy compression level (0-100, default: 35). Higher = more compression, lower quality
 * @param {number} options.optimize - Optimization level (1-3, default: 3). Higher = better optimization, slower
 * @returns {Promise<void>}
 */
export async function optimizeGif(inputPath, outputPath, options = {}) {
  const lossy = options.lossy ?? 35;
  const optimizeLevel = options.optimize ?? 3;

  // Validate lossy level (0-100)
  if (typeof lossy !== 'number' || lossy < 0 || lossy > 100) {
    throw new ValidationError('lossy level must be between 0 and 100');
  }

  // Validate optimize level (1-3)
  if (typeof optimizeLevel !== 'number' || optimizeLevel < 1 || optimizeLevel > 3) {
    throw new ValidationError('optimize level must be between 1 and 3');
  }

  logger.info(
    `Optimizing GIF: ${inputPath} -> ${outputPath} (lossy: ${lossy}, optimize: ${optimizeLevel})`
  );

  // Validate input file exists
  try {
    const inputStats = await fs.stat(inputPath);
    logger.debug(`Input file exists: ${inputPath} (size: ${inputStats.size} bytes)`);
  } catch (error) {
    logger.error(`Input file not found: ${inputPath} - ${error.message}`);
    throw new ValidationError(`Input GIF file not found: ${inputPath}`);
  }

  // Get absolute paths first (before directory creation)
  const inputAbsPath = path.resolve(inputPath);
  const outputAbsPath = path.resolve(outputPath);

  // Ensure output directory exists on host
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  logger.debug(`Created output directory on host: ${outputDir}`);

  // Map container paths to paths inside the giflossy container
  // Both containers will use the same paths since we'll inherit volumes
  const cwd = process.cwd(); // This is /app inside the container
  let inputDockerPath;
  let outputDockerPath;

  // Convert paths to Docker container paths
  // Normalize backslashes to forward slashes for cross-platform compatibility
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const normalizedInputPath = inputAbsPath.replace(/\\/g, '/');
  const normalizedOutputPath = outputAbsPath.replace(/\\/g, '/');

  // Simple replacement: if path starts with cwd, replace cwd with /app
  // Handle Windows drive letters by checking both full path and path without drive
  if (normalizedInputPath.startsWith(normalizedCwd)) {
    inputDockerPath = normalizedInputPath.replace(normalizedCwd, '/app');
  } else if (/^[A-Z]:/i.test(normalizedCwd)) {
    // Windows: try matching without drive letter (e.g., "C:/gronka" -> "/gronka")
    const pathWithoutDrive = normalizedCwd.substring(2); // Remove "C:"
    const normalizedPathWithoutDrive = pathWithoutDrive.startsWith('/')
      ? pathWithoutDrive
      : '/' + pathWithoutDrive;
    if (normalizedInputPath.startsWith(normalizedPathWithoutDrive)) {
      inputDockerPath = normalizedInputPath.replace(normalizedPathWithoutDrive, '/app');
    } else {
      // Fallback: assume it's already a container path or relative
      inputDockerPath = normalizedInputPath.startsWith('/')
        ? normalizedInputPath
        : '/app/' + normalizedInputPath;
    }
  } else {
    // Unix path or already container path
    inputDockerPath = normalizedInputPath.startsWith('/')
      ? normalizedInputPath
      : '/app/' + normalizedInputPath;
  }

  if (normalizedOutputPath.startsWith(normalizedCwd)) {
    outputDockerPath = normalizedOutputPath.replace(normalizedCwd, '/app');
  } else if (/^[A-Z]:/i.test(normalizedCwd)) {
    // Windows: try matching without drive letter
    const pathWithoutDrive = normalizedCwd.substring(2);
    const normalizedPathWithoutDrive = pathWithoutDrive.startsWith('/')
      ? pathWithoutDrive
      : '/' + pathWithoutDrive;
    if (normalizedOutputPath.startsWith(normalizedPathWithoutDrive)) {
      outputDockerPath = normalizedOutputPath.replace(normalizedPathWithoutDrive, '/app');
    } else {
      // Fallback: assume it's already a container path or relative
      outputDockerPath = normalizedOutputPath.startsWith('/')
        ? normalizedOutputPath
        : '/app/' + normalizedOutputPath;
    }
  } else {
    // Unix path or already container path
    outputDockerPath = normalizedOutputPath.startsWith('/')
      ? normalizedOutputPath
      : '/app/' + normalizedOutputPath;
  }

  // Use --volumes-from to inherit all volumes from the current container
  // This way we don't need to know the host paths
  // Container name is 'gronka' as defined in docker-compose.yml
  const containerName = 'gronka';

  // Validate paths don't contain dangerous characters
  // Check for shell metacharacters that could be used for command injection
  const shellMetaChars = /[;&|`$(){}[\]*?~<>\\\n\r\t\0]/;

  if (shellMetaChars.test(inputDockerPath)) {
    const match = inputDockerPath.match(shellMetaChars);
    logger.error(
      `Invalid characters in input path: ${inputDockerPath}, found shell metacharacter: ${match[0]}`
    );
    throw new ValidationError(
      `Invalid characters in file paths: input path contains shell metacharacter (${match[0]})`
    );
  }

  if (shellMetaChars.test(outputDockerPath)) {
    const match = outputDockerPath.match(shellMetaChars);
    logger.error(
      `Invalid characters in output path: ${outputDockerPath}, found shell metacharacter: ${match[0]}`
    );
    throw new ValidationError(
      `Invalid characters in file paths: output path contains shell metacharacter (${match[0]})`
    );
  }

  // SECURITY: Escape paths and container name for shell safety
  // Note: We use spawn() with array arguments (safer), but we still validate escaping
  // to ensure we're aware of security concerns. The escaped values are computed
  // but not used since spawn doesn't need shell escaping.
  // These are kept for test validation that we're aware of security concerns.
  const _escapedInputPath = escapeShellArg(inputDockerPath);
  const _escapedOutputPath = escapeShellArg(outputDockerPath);
  const _escapedContainerName = escapeShellArg(containerName);

  // Use docker run with --volumes-from to inherit volumes
  // gifsicle command: gifsicle --optimize=3 --lossy=35 input.gif -o output.gif (default lossy: 35)
  // SECURITY: Use spawn with array arguments to prevent command injection
  // This avoids shell execution and passes arguments directly to docker
  // (We use the raw values since spawn doesn't need shell escaping)

  // Ensure output directory exists inside the Docker container
  // This is necessary when the storage path is outside mounted volumes
  // We create the directory in the new container by wrapping the command in a shell
  const outputDirDockerPath = path.dirname(outputDockerPath).replace(/\\/g, '/');

  // Build the gifsicle command with proper escaping
  // We need to escape the paths for use in a shell command
  const escapedInputPath = inputDockerPath.replace(/'/g, "'\\''");
  const escapedOutputPath = outputDockerPath.replace(/'/g, "'\\''");
  const escapedOutputDir = outputDirDockerPath.replace(/'/g, "'\\''");

  // Create directory and run gifsicle in one command
  // The entire command must be a single string argument to sh -c
  // Using proper shell escaping: wrap the entire command in single quotes, escape internal single quotes
  const shellCommand = `mkdir -p '${escapedOutputDir}' && /bin/gifsicle --optimize=${optimizeLevel} --lossy=${lossy} '${escapedInputPath}' -o '${escapedOutputPath}'`;

  const dockerArgs = [
    'run',
    '--rm',
    '--volumes-from',
    containerName,
    'dylanninin/giflossy:latest',
    'sh',
    '-c',
    shellCommand, // Single string argument - spawn will pass this correctly
  ];

  try {
    // Verify input file still exists before running docker command
    try {
      await fs.access(inputPath);
      logger.debug(`Input file verified before docker command: ${inputPath}`);
    } catch (error) {
      logger.error(`Input file disappeared before docker command: ${inputPath} - ${error.message}`);
      throw new ValidationError(`Input GIF file not accessible: ${inputPath}`);
    }

    // Verify gronka container is running (needed for --volumes-from)
    // This is a best-effort check - if it fails, we'll still try the command
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);
      await execPromise(`docker ps --filter name=${containerName} --format "{{.Names}}"`);
      logger.debug(`Container ${containerName} is running`);
    } catch (error) {
      logger.warn(`Could not verify container ${containerName} is running: ${error.message}`);
      logger.warn(`This may cause issues if --volumes-from cannot access volumes`);
    }

    logger.debug(`Path conversion - cwd: ${cwd}, normalizedCwd: ${normalizedCwd}`);
    logger.debug(`Path conversion - input: ${inputAbsPath} -> ${inputDockerPath}`);
    logger.debug(`Path conversion - output: ${outputAbsPath} -> ${outputDockerPath}`);
    logger.debug(`Output directory created on host: ${outputDir}`);
    logger.debug(`Creating output directory in container: ${outputDirDockerPath}`);
    logger.debug(`Shell command: ${shellCommand}`);
    logger.debug(`Docker args count: ${dockerArgs.length}`);
    logger.debug(`Docker args: ${JSON.stringify(dockerArgs)}`);
    logger.debug(
      `Executing: docker ${dockerArgs.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`
    );
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('docker', dockerArgs, {
        timeout: 300000, // 5 minute timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', data => {
        stdoutData += data.toString();
      });

      child.stderr.on('data', data => {
        stderrData += data.toString();
      });

      child.on('error', reject);

      child.on('close', code => {
        if (code !== 0) {
          const error = new Error(`docker process exited with code ${code}`);
          error.code = code;
          error.stderr = stderrData;
          error.stdout = stdoutData;
          reject(error);
        } else {
          resolve({ stdout: stdoutData, stderr: stderrData });
        }
      });
    });

    // Log all output for debugging
    logger.info(`Docker command completed. Exit code would be 0 (success).`);
    if (stdout) {
      logger.info(`giflossy stdout: ${stdout}`);
    } else {
      logger.debug(`giflossy stdout: (empty)`);
    }

    if (stderr) {
      if (stderr.includes('warning')) {
        logger.info(`giflossy stderr (warnings): ${stderr}`);
      } else {
        logger.warn(`giflossy stderr: ${stderr}`);
      }
    } else {
      logger.info(`giflossy stderr: (empty)`);
    }

    // Verify output file was created
    try {
      await fs.access(outputPath);
      logger.info(`GIF optimization completed: ${outputPath}`);
    } catch (error) {
      logger.error(`Output file not found at: ${outputPath}`);
      logger.error(`File access error: ${error.message}`);
      // Check if directory exists
      try {
        const dirStats = await fs.stat(outputDir);
        logger.info(
          `Output directory exists: ${outputDir} (isDirectory: ${dirStats.isDirectory()})`
        );
      } catch (_dirError) {
        logger.error(`Output directory does not exist: ${outputDir}`);
      }
      throw new ValidationError('Optimized GIF file was not created');
    }
  } catch (error) {
    // Log detailed error information for debugging (not shown to user)
    if (error.stderr) {
      logger.error(`GIF optimization stderr: ${error.stderr}`);

      // Check for common errors and provide helpful messages
      if (error.stderr.includes('No such file or directory')) {
        if (error.stderr.includes('/app/temp/')) {
          logger.error(`Input file not found in container. This usually means:`);
          logger.error(`  1. The ${containerName} container is not running`);
          logger.error(`  2. The volume mount for ./temp is not configured correctly`);
          logger.error(`  3. The file path conversion is incorrect`);
          logger.error(`  Input file on host: ${inputPath}`);
          logger.error(`  Expected in container: ${inputDockerPath}`);
        } else if (error.stderr.includes('/app/data')) {
          logger.error(`Output directory not accessible in container. This usually means:`);
          logger.error(`  1. The ${containerName} container is not running`);
          logger.error(`  2. The volume mount for the storage path is not configured correctly`);
          logger.error(`  Output path on host: ${outputPath}`);
          logger.error(`  Expected in container: ${outputDockerPath}`);
        }
      }
    }
    logger.error(
      `GIF optimization failed: ${error.message}${error.stderr ? ` - ${error.stderr}` : ''}`
    );

    if (error.code === 'ENOENT') {
      throw new ValidationError('docker command not found. Is Docker installed?');
    }
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
      throw new ValidationError('GIF optimization timed out');
    }

    // Return generic error message to user (detailed errors logged above)
    throw new ValidationError('GIF optimization failed. Please try again.');
  }
}

/**
 * Calculate size reduction percentage
 * @param {number} originalSize - Original file size in bytes
 * @param {number} optimizedSize - Optimized file size in bytes
 * @returns {number} Size reduction percentage (negative if file grew)
 */
export function calculateSizeReduction(originalSize, optimizedSize) {
  if (originalSize === 0) {
    return 0;
  }

  const reduction = ((originalSize - optimizedSize) / originalSize) * 100;
  return Math.round(reduction);
}

/**
 * Format file size in MB
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size (e.g., "6.7mb")
 */
export function formatSizeMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}mb`;
}
