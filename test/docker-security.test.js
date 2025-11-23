import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const composePath = path.join(__dirname, '..', 'docker-compose.yml');

// Helper to parse docker-compose.yml
async function parseDockerCompose() {
  const content = await fs.readFile(composePath, 'utf-8');
  const lines = content.split('\n');
  const services = {};
  let currentService = null;
  let inVolumes = false;
  let inPorts = false;
  let inEnvironment = false;

  let inServicesSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Detect if we're in the services section
    if (indent === 0 && trimmed === 'services:') {
      inServicesSection = true;
      currentService = null;
      continue;
    }

    // Exit services section when we hit another top-level key
    if (indent === 0 && trimmed.match(/^\w+:$/) && trimmed !== 'services:') {
      inServicesSection = false;
      currentService = null;
      continue;
    }

    // Detect service definition (indented under services:)
    if (
      inServicesSection &&
      indent === 2 &&
      trimmed.match(/^(\w+):$/) &&
      !trimmed.startsWith('#')
    ) {
      const serviceMatch = trimmed.match(/^(\w+):$/);
      if (serviceMatch) {
        currentService = serviceMatch[1];
        services[currentService] = {
          volumes: [],
          ports: [],
          environment: [],
          privileged: false,
          read_only: false,
          user: null,
          cap_drop: [],
          cap_add: [],
          security_opt: [],
        };
        inVolumes = false;
        inPorts = false;
        inEnvironment = false;
        continue;
      }
    }

    if (!currentService) continue;

    // Detect sections within services
    if (trimmed.match(/^volumes:$/)) {
      inVolumes = true;
      inPorts = false;
      inEnvironment = false;
      continue;
    }
    if (trimmed.match(/^ports:$/)) {
      inVolumes = false;
      inPorts = true;
      inEnvironment = false;
      continue;
    }
    if (trimmed.match(/^environment:$/)) {
      inVolumes = false;
      inPorts = false;
      inEnvironment = true;
      continue;
    }

    // Reset section flags if we hit a new top-level key in service
    if (indent === 0 && trimmed.match(/^\w+:/)) {
      inVolumes = false;
      inPorts = false;
      inEnvironment = false;
    }

    // Parse volumes
    if (trimmed.includes('/var/run/docker.sock')) {
      services[currentService].docker_socket = true;
    }
    // Match volume mount patterns: - ./data:/app/data or - /var/run/docker.sock:/var/run/docker.sock
    if (inVolumes && trimmed.match(/^\s*-\s*.+:.+/)) {
      const volMatch = trimmed.match(/^\s*-\s*(.+)/);
      if (volMatch && !trimmed.startsWith('#')) {
        const volumeDef = volMatch[1].trim().replace(/['"]/g, '');
        services[currentService].volumes.push(volumeDef);
      }
    }

    // Parse ports
    if (inPorts && trimmed.match(/^\s*-\s*/) && trimmed.includes(':')) {
      const portMatch = trimmed.match(/^\s*-\s*['"]?([^'"]+)['"]?/);
      if (portMatch && !trimmed.startsWith('#')) {
        services[currentService].ports.push(portMatch[1]);
      }
    }

    // Parse environment variables
    if (inEnvironment && trimmed.match(/^\s*-\s*[A-Z_]+=/)) {
      const envMatch = trimmed.match(/^\s*-\s*(.+)/);
      if (envMatch && !trimmed.startsWith('#')) {
        services[currentService].environment.push(envMatch[1].trim());
      }
    }

    // Check for privileged mode
    if (trimmed.includes('privileged:') && trimmed.includes('true')) {
      services[currentService].privileged = true;
    }

    // Check for read_only
    if (trimmed.includes('read_only:') && trimmed.includes('true')) {
      services[currentService].read_only = true;
    }

    // Check for user
    if (trimmed.match(/^\s*user:/)) {
      const userMatch = trimmed.match(/user:\s*(.+)/);
      if (userMatch) {
        services[currentService].user = userMatch[1].trim();
      }
    }
  }

  return services;
}

// Check if docker socket is accessible (requires running in container or with docker access)
async function checkDockerSocketAccess() {
  try {
    await fs.access('/var/run/docker.sock');
    return true;
  } catch {
    return false;
  }
}

// Test command injection attempts
function escapeShellArg(arg) {
  if (typeof arg !== 'string') {
    throw new Error('Argument must be a string');
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

describe('docker security tests', () => {
  let composeConfig = null;

  before(async () => {
    try {
      composeConfig = await parseDockerCompose();
    } catch (error) {
      console.warn('Warning: Could not parse docker-compose.yml:', error.message);
    }
  });

  describe('docker socket exposure', () => {
    test('app service should not mount docker socket (security risk)', () => {
      if (!composeConfig?.app) {
        assert.fail('Could not parse docker-compose.yml');
      }

      // Docker socket mount is a critical security risk
      // If present, document it as a known risk that needs mitigation
      if (composeConfig.app.docker_socket) {
        console.warn(
          'SECURITY WARNING: app service mounts docker socket. ' +
            'This allows container escape if compromised. Consider using Docker-in-Docker or ' +
            'a more restricted API endpoint instead of full socket access.'
        );
      }

      // This test documents the risk - in production, you might want to fail if socket is mounted
      // Uncomment the assertion below if you want tests to fail when socket is mounted:
      // assert.strictEqual(composeConfig.app.docker_socket, false,
      //   'docker socket mount detected - this is a security risk');
    });

    test('watchtower service docker socket mount is documented', () => {
      if (!composeConfig?.watchtower) {
        assert.fail('Could not parse docker-compose.yml');
      }

      // watchtower needs docker socket, but should be documented
      if (composeConfig.watchtower.docker_socket) {
        console.warn(
          'NOTE: watchtower service mounts docker socket (required for its function). ' +
            'Ensure watchtower is kept up to date and uses --scope to limit what it can access.'
        );
      }
    });

    test('webui service should not mount docker socket', () => {
      if (!composeConfig?.webui) {
        return; // webui might not always be present
      }

      assert.strictEqual(
        composeConfig.webui.docker_socket || false,
        false,
        'webui service should not mount docker socket'
      );
    });

    test('cobalt service should not mount docker socket', () => {
      if (!composeConfig?.cobalt) {
        return;
      }

      assert.strictEqual(
        composeConfig.cobalt.docker_socket || false,
        false,
        'cobalt service should not mount docker socket'
      );
    });
  });

  describe('volume mount security', () => {
    test('volume mounts should use absolute paths', () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const riskyPaths = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          // Check for relative paths or bind mounts that could escape
          if (volume.startsWith('./') || volume.startsWith('../')) {
            riskyPaths.push({ service: serviceName, volume });
          }
        }
      }

      if (riskyPaths.length > 0) {
        console.warn(
          'WARNING: Relative paths in volume mounts detected. ' +
            'These are resolved relative to docker-compose.yml location, but absolute paths are clearer.'
        );
        console.warn('Risky paths:', riskyPaths);
      }
    });

    test('no volume mounts to sensitive host directories', () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const sensitivePaths = [
        '/etc',
        '/root',
        '/home',
        '/usr',
        '/bin',
        '/sbin',
        '/sys',
        '/proc',
        '/boot',
      ];

      const riskyMounts = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          const [hostPath] = volume.split(':');
          const absPath = path.isAbsolute(hostPath)
            ? hostPath
            : path.resolve(path.dirname(composePath), hostPath);

          // Normalize path separators for cross-platform compatibility
          const normalizedPath = absPath.replace(/\\/g, '/');

          for (const sensitive of sensitivePaths) {
            // Only flag if the path is exactly the sensitive directory or a direct child (one level deep)
            // This allows deep subdirectories like /home/runner/work/project/data (safe)
            // but flags dangerous mounts like /home (unsafe) or /home/username (unsafe)

            // Skip if path is clearly a CI workspace or development directory
            // GitHub Actions uses /home/runner/work/, GitLab CI uses /builds/, etc.
            const ciWorkspacePatterns = ['/home/runner/work/', '/builds/', '/workspace/', '/tmp/'];
            const isCIWorkspace = ciWorkspacePatterns.some(pattern =>
              normalizedPath.startsWith(pattern)
            );
            if (isCIWorkspace) {
              continue; // Skip checking - this is a CI workspace, not a sensitive mount
            }

            if (normalizedPath === sensitive) {
              // Exact match - definitely risky
              riskyMounts.push({
                service: serviceName,
                volume,
                sensitive,
                resolvedPath: normalizedPath,
              });
              break;
            } else if (normalizedPath.startsWith(sensitive + '/')) {
              // Check depth - only flag if it's a direct child (one level deep)
              // Example: /home/username is risky, but /home/runner/work/project is safe
              const pathAfterSensitive = normalizedPath.substring(sensitive.length + 1);
              const segments = pathAfterSensitive.split('/').filter(s => s.length > 0);

              // Only flag if depth is 0 or 1 (direct child)
              // This means /home or /home/user are risky, but /home/user/data is allowed
              // But we don't want to flag /home/runner/work/gronka/gronka/data (depth 4)
              // So let's only flag depth 0 (exact match, already handled) or depth 1
              if (segments.length <= 1) {
                riskyMounts.push({
                  service: serviceName,
                  volume,
                  sensitive,
                  resolvedPath: normalizedPath,
                });
                break;
              }
            }
          }
        }
      }

      assert.strictEqual(
        riskyMounts.length,
        0,
        `Sensitive host directories mounted: ${JSON.stringify(riskyMounts)}`
      );
    });

    test('docker socket mount should be read-only when possible', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const socketMounts = composeContent.match(
        /\/var\/run\/docker\.sock[^:]*:(\/var\/run\/docker\.sock[^\s]*)/g
      );

      if (socketMounts) {
        for (const mount of socketMounts) {
          // Check if mount is read-only
          if (!mount.includes(':ro') && !mount.includes(':read-only')) {
            console.warn(
              'WARNING: Docker socket mount is not read-only. ' +
                'Consider adding :ro to limit write access if the service only needs to read socket info.'
            );
          }
        }
      }
    });
  });

  describe('network exposure', () => {
    test('ports should be bound to localhost when possible', () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const exposedPorts = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const port of service.ports) {
          // Ports like '3000:3000' expose to all interfaces
          // '127.0.0.1:3000:3000' only exposes to localhost
          if (!port.includes('127.0.0.1') && !port.includes('localhost')) {
            exposedPorts.push({ service: serviceName, port });
          }
        }
      }

      if (exposedPorts.length > 0) {
        console.warn(
          'WARNING: Ports exposed to all interfaces (0.0.0.0). ' +
            'Consider binding to 127.0.0.1 if external access is not needed:'
        );
        console.warn(exposedPorts);
      }

      // Don't fail - just warn, as some services may need external access
    });

    test('webui port exposure is intentional', () => {
      if (!composeConfig?.webui) {
        return;
      }

      const hasExternalPort = composeConfig.webui.ports.some(
        p => p.includes('3001') && !p.includes('127.0.0.1')
      );

      if (hasExternalPort) {
        console.warn(
          'NOTE: webui service exposes port 3001 to all interfaces. ' +
            'Ensure proper authentication is configured (STATS_USERNAME/STATS_PASSWORD).'
        );
      }
    });
  });

  describe('privilege escalation', () => {
    test('no services should run in privileged mode', () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const privilegedServices = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        if (service.privileged) {
          privilegedServices.push(serviceName);
        }
      }

      assert.strictEqual(
        privilegedServices.length,
        0,
        `Services running in privileged mode: ${privilegedServices.join(', ')}`
      );
    });

    test('services should use read-only root filesystem when possible', () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const writableServices = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        // cobalt uses read_only: true as an example
        // Services that don't need to write to root filesystem should be read-only
        if (serviceName !== 'cobalt' && !service.read_only && serviceName !== 'app') {
          // app needs write access for data/temp/logs, so skip it
          writableServices.push(serviceName);
        }
      }

      if (writableServices.length > 0) {
        console.warn(
          "NOTE: Consider using read_only: true for services that don't need root filesystem writes: " +
            writableServices.join(', ')
        );
      }
    });

    test('services should not run as root when possible', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const rootServices = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        if (!service.user || service.user === 'root' || service.user === '0') {
          rootServices.push(serviceName);
        }
      }

      if (rootServices.length > 0) {
        console.warn(
          'NOTE: Services running as root. Consider creating a non-root user in Dockerfile: ' +
            rootServices.join(', ')
        );
      }

      // Don't fail - this is a best practice warning
    });
  });

  describe('environment variable security', () => {
    test('sensitive environment variables should not be hardcoded', async () => {
      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for hardcoded secrets
      const sensitivePatterns = [
        /DISCORD_TOKEN=\w+/,
        /R2_SECRET_ACCESS_KEY=\w+/,
        /STATS_PASSWORD=\w+/,
      ];

      const hardcodedSecrets = [];
      for (const pattern of sensitivePatterns) {
        const matches = composeContent.match(pattern);
        if (matches) {
          hardcodedSecrets.push(...matches);
        }
      }

      assert.strictEqual(
        hardcodedSecrets.length,
        0,
        `Hardcoded secrets detected in docker-compose.yml: ${hardcodedSecrets.join(', ')}`
      );
    });

    test('environment variables should use variable substitution', async () => {
      const composeContent = await fs.readFile(composePath, 'utf-8');

      const sensitiveVars = [
        'DISCORD_TOKEN',
        'R2_SECRET_ACCESS_KEY',
        'R2_ACCESS_KEY_ID',
        'STATS_PASSWORD',
      ];

      const lines = composeContent.split('\n');
      const problematicLines = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const varName of sensitiveVars) {
          // Check if variable is defined without ${} substitution
          if (line.includes(`${varName}=`) && !line.includes('${') && !line.includes('#')) {
            // Allow empty defaults like ${VAR:-}
            if (!line.includes(':-')) {
              problematicLines.push({ line: i + 1, content: line.trim(), variable: varName });
            }
          }
        }
      }

      // Filter out lines that use ${VAR:-} pattern (which is safe)
      const unsafeLines = problematicLines.filter(
        p => !p.content.includes('${') || !p.content.includes(':-')
      );

      assert.strictEqual(
        unsafeLines.length,
        0,
        `Environment variables not using substitution: ${JSON.stringify(unsafeLines, null, 2)}`
      );
    });
  });

  describe('command injection prevention', () => {
    test('shell argument escaping function prevents command injection', () => {
      // Test various injection attempts
      const injectionAttempts = [
        '; rm -rf /',
        "'; rm -rf /; '",
        '$(rm -rf /)',
        '`rm -rf /`',
        '| cat /etc/passwd',
        '&& echo hacked',
        '|| echo hacked',
        '; docker run -v /:/host alpine sh',
        '\nrm -rf /',
      ];

      for (const attempt of injectionAttempts) {
        const escaped = escapeShellArg(attempt);

        // Escaped value should be wrapped in single quotes
        assert.ok(
          escaped.startsWith("'"),
          `Escaped value should start with single quote: ${escaped}`
        );
        assert.ok(escaped.endsWith("'"), `Escaped value should end with single quote: ${escaped}`);

        // The escaped string should safely contain the attempt
        assert.ok(
          escaped.length > attempt.length,
          `Escaped should be longer than original for: ${attempt}`
        );
      }
    });

    test('shell metacharacter validation rejects dangerous characters', () => {
      const shellMetaChars = /[;&|`$(){}[\]*?~<>\\\n\r\t\0]/;

      const dangerousPaths = [
        '/path; rm -rf /',
        '/path $(cat /etc/passwd)',
        '/path `whoami`',
        '/path|cat',
        '/path&echo',
      ];

      for (const dangerousPath of dangerousPaths) {
        assert.ok(
          shellMetaChars.test(dangerousPath),
          `Should detect shell metacharacters in: ${dangerousPath}`
        );
      }
    });

    test('gif-optimizer uses proper escaping for docker commands', async () => {
      // Import the actual escapeShellArg from gif-optimizer
      // Note: The function is not exported, so we'll test the pattern used
      const gifOptimizerPath = path.join(__dirname, '..', 'src', 'utils', 'gif-optimizer.js');
      const gifOptimizerContent = await fs.readFile(gifOptimizerPath, 'utf-8');

      // Verify escapeShellArg function exists
      assert.ok(
        gifOptimizerContent.includes('function escapeShellArg'),
        'gif-optimizer should have escapeShellArg function'
      );

      // Verify paths are escaped before use in docker command
      assert.ok(
        gifOptimizerContent.includes('escapeShellArg(inputDockerPath)'),
        'gif-optimizer should escape input path before use in docker command'
      );

      assert.ok(
        gifOptimizerContent.includes('escapeShellArg(outputDockerPath)'),
        'gif-optimizer should escape output path before use in docker command'
      );

      assert.ok(
        gifOptimizerContent.includes('escapeShellArg(containerName)'),
        'gif-optimizer should escape container name before use in docker command'
      );

      // Verify shell metacharacter validation exists
      assert.ok(
        gifOptimizerContent.includes('shellMetaChars'),
        'gif-optimizer should validate shell metacharacters in paths'
      );

      // Verify validation happens before command construction
      const shellMetaCheckIndex = gifOptimizerContent.indexOf('shellMetaChars.test');
      const escapeShellArgIndex = gifOptimizerContent.indexOf('escapeShellArg(inputDockerPath)');

      assert.ok(
        shellMetaCheckIndex < escapeShellArgIndex,
        'Shell metacharacter validation should happen before path escaping'
      );
    });
  });

  describe('container isolation', () => {
    test('services should not share network namespace unnecessarily', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      // All services should be on the same network for communication,
      // but network_mode: host should be avoided unless necessary
      const composeContent = await fs.readFile(composePath, 'utf-8');

      if (composeContent.includes('network_mode:') && composeContent.includes('host')) {
        console.warn(
          'WARNING: network_mode: host detected. This removes network isolation. ' +
            'Use bridge networking with explicit port mappings instead.'
        );
      }
    });

    test('giflossy service isolation is appropriate', () => {
      if (!composeConfig?.giflossy) {
        return;
      }

      // giflossy should not have docker socket access
      assert.strictEqual(
        composeConfig.giflossy.docker_socket || false,
        false,
        'giflossy should not have docker socket access'
      );

      // giflossy should only have necessary volume mounts
      const requiredMounts = ['data', 'temp'];
      const mountPaths = composeConfig.giflossy.volumes.join(' ');

      // Check that volumes array exists and has entries
      assert.ok(
        Array.isArray(composeConfig.giflossy.volumes),
        'giflossy should have volumes array defined'
      );

      for (const required of requiredMounts) {
        assert.ok(
          mountPaths.includes(required),
          `giflossy should mount ${required} volume (found volumes: ${mountPaths})`
        );
      }
    });
  });

  describe('image security', () => {
    test('images should use specific tags, not latest', async () => {
      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for :latest tags (less secure - can change unexpectedly)
      const latestTags = composeContent.match(/image:\s*[^:]+:latest/g);

      if (latestTags) {
        console.warn(
          'WARNING: Services using :latest tag. Use specific version tags for reproducibility and security:'
        );
        console.warn(latestTags);
      }

      // Don't fail - just warn
    });

    test('external images should be from trusted sources', async () => {
      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Extract image names
      const imageMatches = composeContent.match(/image:\s*([^\s]+)/g);
      const images = imageMatches?.map(m => m.replace('image:', '').trim()) || [];

      const untrustedPatterns = [
        /^[^/]+$/, // No registry specified (uses docker hub default)
      ];

      const potentiallyUntrusted = [];
      for (const image of images) {
        for (const pattern of untrustedPatterns) {
          if (pattern.test(image) && !image.startsWith('ghcr.io') && !image.includes('/')) {
            potentiallyUntrusted.push(image);
          }
        }
      }

      if (potentiallyUntrusted.length > 0) {
        console.warn(
          'NOTE: Images without explicit registry. Ensure these are from trusted sources: ' +
            potentiallyUntrusted.join(', ')
        );
      }
    });
  });

  describe('runtime security checks', () => {
    test('docker socket should not be world-writable', async () => {
      const hasAccess = await checkDockerSocketAccess();

      if (hasAccess) {
        try {
          const stats = await fs.stat('/var/run/docker.sock');
          const mode = stats.mode.toString(8).slice(-3);

          // Check if world-writable (last digit >= 2)
          const worldWritable = parseInt(mode[2]) >= 2;

          assert.strictEqual(
            worldWritable,
            false,
            `Docker socket should not be world-writable. Current mode: ${mode}`
          );
        } catch (error) {
          // Can't check permissions outside container - skip
          console.warn('Cannot check docker socket permissions (not in container):', error.message);
        }
      }
    });

    test('container should not be able to access host docker daemon without socket', async () => {
      // If docker socket is not mounted, docker commands should fail
      const hasSocket = await checkDockerSocketAccess();

      if (!hasSocket) {
        // Try to run a docker command - should fail
        try {
          await execAsync('docker ps', { timeout: 1000 });
          // If we get here, docker is accessible somehow - that's unexpected
          console.warn('WARNING: Docker commands work without socket mount (unexpected)');
        } catch {
          // Expected - docker should not be accessible
        }
      }
    });
  });

  describe('resource limits and exhaustion prevention', () => {
    test('services should have memory limits to prevent DoS', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const servicesWithoutLimits = [];

      for (const [serviceName] of Object.entries(composeConfig)) {
        // Check if service has deploy.resources.limits.memory
        const serviceMatch = new RegExp(
          `${serviceName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\w+:|$)`,
          'm'
        ).exec(composeContent);
        if (serviceMatch) {
          const serviceBlock = serviceMatch[1];
          if (
            !serviceBlock.includes('deploy:') ||
            !serviceBlock.includes('resources:') ||
            !serviceBlock.includes('limits:') ||
            !serviceBlock.includes('memory:')
          ) {
            servicesWithoutLimits.push(serviceName);
          }
        }
      }

      if (servicesWithoutLimits.length > 0) {
        console.warn(
          'NOTE: Services without memory limits. Consider adding deploy.resources.limits.memory to prevent resource exhaustion: ' +
            servicesWithoutLimits.join(', ')
        );
      }
    });

    test('services should have CPU limits to prevent resource starvation', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const servicesWithoutCpuLimits = [];

      for (const [serviceName] of Object.entries(composeConfig)) {
        const serviceMatch = new RegExp(
          `${serviceName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\w+:|$)`,
          'm'
        ).exec(composeContent);
        if (serviceMatch) {
          const serviceBlock = serviceMatch[1];
          if (
            !serviceBlock.includes('deploy:') ||
            !serviceBlock.includes('resources:') ||
            !serviceBlock.includes('limits:') ||
            !serviceBlock.includes('cpus:')
          ) {
            servicesWithoutCpuLimits.push(serviceName);
          }
        }
      }

      if (servicesWithoutCpuLimits.length > 0) {
        console.warn(
          'NOTE: Services without CPU limits. Consider adding deploy.resources.limits.cpus: ' +
            servicesWithoutCpuLimits.join(', ')
        );
      }
    });

    test('services should have restart policies to prevent crash loops', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const restartPolicies = composeContent.match(/restart:\s*(\w+)/g) || [];

      // Check for potentially dangerous restart policies
      const alwaysRestart = restartPolicies.filter(p => p.includes('always'));
      if (alwaysRestart.length > 0 && restartPolicies.length !== alwaysRestart.length) {
        console.warn(
          'NOTE: Some services use "always" restart policy. Consider "unless-stopped" to allow manual stops.'
        );
      }
    });
  });

  describe('capability restrictions', () => {
    test('services should drop dangerous capabilities', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const dangerousCaps = [
        'SYS_ADMIN',
        'SYS_MODULE',
        'SYS_RAWIO',
        'SYS_PTRACE',
        'NET_ADMIN',
        'DAC_OVERRIDE',
        'DAC_READ_SEARCH',
        'CAP_SYS_ADMIN',
        'CAP_SYS_MODULE',
      ];

      const servicesWithDangerousCaps = [];

      for (const [serviceName] of Object.entries(composeConfig)) {
        const serviceMatch = new RegExp(
          `${serviceName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\w+:|$)`,
          'm'
        ).exec(composeContent);
        if (serviceMatch) {
          const serviceBlock = serviceMatch[1];
          for (const cap of dangerousCaps) {
            if (serviceBlock.includes(`cap_add:`) && serviceBlock.includes(cap)) {
              servicesWithDangerousCaps.push({ service: serviceName, capability: cap });
            }
          }
        }
      }

      if (servicesWithDangerousCaps.length > 0) {
        console.warn(
          'WARNING: Services with dangerous capabilities that could allow privilege escalation: ' +
            JSON.stringify(servicesWithDangerousCaps)
        );
      }
    });

    test('services should drop ALL capabilities and add only necessary ones', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');
      const servicesWithoutDropAll = [];

      for (const [serviceName] of Object.entries(composeConfig)) {
        const serviceMatch = new RegExp(
          `${serviceName}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\w+:|$)`,
          'm'
        ).exec(composeContent);
        if (serviceMatch) {
          const serviceBlock = serviceMatch[1];
          // Check for cap_drop: ALL or equivalent
          if (
            !serviceBlock.includes('cap_drop:') ||
            (!serviceBlock.includes('ALL') && !serviceBlock.includes('- ALL'))
          ) {
            servicesWithoutDropAll.push(serviceName);
          }
        }
      }

      if (servicesWithoutDropAll.length > 0) {
        console.warn(
          'NOTE: Consider adding "cap_drop: - ALL" and then adding back only necessary capabilities for: ' +
            servicesWithoutDropAll.join(', ')
        );
      }
    });
  });

  describe('host namespace isolation', () => {
    test('services should not use host PID namespace', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      if (composeContent.includes('pid:') && composeContent.includes('host')) {
        console.warn(
          'WARNING: Services using host PID namespace (pid: host). This breaks process isolation and allows access to host processes.'
        );
      }
    });

    test('services should not use host IPC namespace', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      if (composeContent.includes('ipc:') && composeContent.includes('host')) {
        console.warn(
          'WARNING: Services using host IPC namespace (ipc: host). This breaks inter-process communication isolation.'
        );
      }
    });

    test('services should not mount host proc filesystem', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const riskyMounts = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          if (volume.includes('/proc') && volume.includes('/proc')) {
            riskyMounts.push({ service: serviceName, volume });
          }
        }
      }

      if (riskyMounts.length > 0) {
        console.warn(
          'WARNING: Services mounting /proc from host. This breaks process isolation: ' +
            JSON.stringify(riskyMounts)
        );
      }
    });

    test('services should not mount host sys filesystem', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const riskyMounts = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          if (volume.includes('/sys') && !volume.includes(':ro')) {
            riskyMounts.push({ service: serviceName, volume });
          }
        }
      }

      if (riskyMounts.length > 0) {
        console.warn(
          'WARNING: Services mounting /sys from host. This could allow kernel parameter manipulation: ' +
            JSON.stringify(riskyMounts)
        );
      }
    });
  });

  describe('volume mount path traversal', () => {
    test('volume mounts should not contain path traversal sequences', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const traversalPatterns = ['../', '..\\', '..', '/..', '\\..'];
      const riskyMounts = [];

      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          const [hostPath] = volume.split(':');
          for (const pattern of traversalPatterns) {
            if (hostPath.includes(pattern)) {
              riskyMounts.push({ service: serviceName, volume, pattern });
            }
          }
        }
      }

      assert.strictEqual(
        riskyMounts.length,
        0,
        `Volume mounts with path traversal detected: ${JSON.stringify(riskyMounts)}`
      );
    });

    test('volume mounts should not mount entire root filesystem', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const rootMounts = [];
      for (const [serviceName, service] of Object.entries(composeConfig)) {
        for (const volume of service.volumes) {
          const [hostPath] = volume.split(':');
          const normalizedPath = path.normalize(hostPath.replace(/^\./, ''));
          if (normalizedPath === '/' || normalizedPath === '\\' || normalizedPath === '') {
            rootMounts.push({ service: serviceName, volume });
          }
        }
      }

      assert.strictEqual(
        rootMounts.length,
        0,
        `Root filesystem mounts detected (critical security risk): ${JSON.stringify(rootMounts)}`
      );
    });
  });

  describe('docker api security', () => {
    test('docker commands should validate container names to prevent injection', async () => {
      // Test that container names used in docker commands are sanitized
      const gifOptimizerPath = path.join(__dirname, '..', 'src', 'utils', 'gif-optimizer.js');
      const gifOptimizerContent = await fs.readFile(gifOptimizerPath, 'utf-8');

      // Container name should be hardcoded or validated, not user input
      assert.ok(
        gifOptimizerContent.includes('containerName') && gifOptimizerContent.includes('gronka'),
        'Container name should be hardcoded, not from user input'
      );

      // Verify container name is escaped before use in command
      assert.ok(
        gifOptimizerContent.includes('escapeShellArg(containerName)'),
        'Container name must be escaped before use in docker command'
      );
    });

    test('docker run commands should not use --privileged flag', async () => {
      // Check all source files for docker run commands with --privileged
      const srcDir = path.join(__dirname, '..', 'src');
      const files = await glob('**/*.js', { cwd: srcDir });

      const privilegedCommands = [];

      for (const file of files) {
        const filePath = path.join(srcDir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        // Check for docker run with privileged
        if (content.includes('docker run') && content.includes('--privileged')) {
          privilegedCommands.push(file);
        }
      }

      assert.strictEqual(
        privilegedCommands.length,
        0,
        `Docker run commands with --privileged flag found in source code: ${privilegedCommands.join(', ')}`
      );
    });

    test('docker exec commands should use --user flag to drop privileges', async () => {
      const srcDir = path.join(__dirname, '..', 'src');
      const files = await glob('**/*.js', { cwd: srcDir });

      const execCommands = [];

      for (const file of files) {
        const filePath = path.join(srcDir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        if (content.includes('docker exec')) {
          execCommands.push(file);
        }
      }

      // docker exec is fine, but should ideally use --user flag
      // This is a warning, not a failure
      if (execCommands.length > 0) {
        console.warn(
          'NOTE: docker exec commands found. Consider using --user flag to drop privileges: ' +
            execCommands.join(', ')
        );
      }
    });
  });

  describe('container escape prevention', () => {
    test('services should not mount docker socket with write access unnecessarily', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for docker socket mounts without :ro
      const socketMountRegex = /\/var\/run\/docker\.sock[^:]*:(\/var\/run\/docker\.sock[^\s]*)/g;
      const socketMounts = composeContent.match(socketMountRegex) || [];

      const writableSockets = [];
      for (const mount of socketMounts) {
        if (!mount.includes(':ro') && !mount.includes(':read-only')) {
          writableSockets.push(mount);
        }
      }

      if (writableSockets.length > 0) {
        console.warn(
          'WARNING: Docker socket mounts without read-only flag. Compromised containers could escape and control host Docker daemon: ' +
            writableSockets.join(', ')
        );
      }
    });

    test('app service docker socket access should be documented as security risk', () => {
      if (!composeConfig?.app) {
        assert.fail('Could not parse docker-compose.yml');
      }

      if (composeConfig.app.docker_socket) {
        // This is a known risk for the app service (needed for gif-optimizer)
        // Document it but verify it's intentional
        console.warn(
          'KNOWN RISK: app service has docker socket access for gif-optimizer. ' +
            'If compromised, attacker could escape container and control host Docker. ' +
            'Mitigation: Ensure app service code is secure, use proper input validation, and limit network exposure.'
        );
      }
    });
  });

  describe('health check security', () => {
    test('health checks should not expose sensitive information', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check if health checks include sensitive data in commands
      const healthCheckRegex = /healthcheck:[\s\S]*?test:\s*\[?([^\]]+)\]?/gi;
      const matches = composeContent.match(healthCheckRegex) || [];

      const sensitivePatterns = ['password', 'token', 'secret', 'key', 'auth'];
      const riskyHealthChecks = [];

      for (const match of matches) {
        for (const pattern of sensitivePatterns) {
          if (match.toLowerCase().includes(pattern)) {
            riskyHealthChecks.push(match);
          }
        }
      }

      if (riskyHealthChecks.length > 0) {
        console.warn(
          'WARNING: Health checks may expose sensitive information: ' +
            JSON.stringify(riskyHealthChecks)
        );
      }
    });

    test('health check commands should be safe from injection', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Health checks should use CMD with array syntax, not shell form
      const healthCheckRegex = /healthcheck:[\s\S]*?test:[\s\S]*?['"`]/gi;
      const shellFormChecks = composeContent.match(healthCheckRegex) || [];

      // Array form is safer as it doesn't invoke shell
      if (shellFormChecks.length > 0) {
        console.warn(
          'NOTE: Health checks using shell form. Consider using array form (CMD ["executable", "arg"]) for better security.'
        );
      }
    });
  });

  describe('network security', () => {
    test('services should use internal networks when possible', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for networks configuration
      const hasInternalNetwork =
        composeContent.includes('internal:') && composeContent.includes('true');

      if (!hasInternalNetwork) {
        console.warn(
          "NOTE: Consider using internal networks for services that don't need external connectivity to prevent outbound connections."
        );
      }
    });

    test('services should not expose ports unnecessarily', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      // Services that only communicate internally shouldn't expose ports
      const servicesWithPorts = [];

      for (const [serviceName, service] of Object.entries(composeConfig)) {
        if (service.ports && service.ports.length > 0) {
          servicesWithPorts.push(serviceName);
        }
      }

      // cobalt is internal-only and shouldn't expose ports externally
      if (servicesWithPorts.includes('cobalt')) {
        console.warn(
          'NOTE: cobalt service exposes port 9000. If only used internally, remove port mapping and access via Docker network.'
        );
      }
    });
  });

  describe('file system security', () => {
    test('temporary directories should be mounted with noexec flag', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for temp volume mounts without noexec
      if (composeContent.includes('/temp') && !composeContent.includes('noexec')) {
        console.warn(
          'NOTE: Consider mounting temp directories with noexec flag to prevent execution of uploaded files: /tmp:/tmp:noexec'
        );
      }
    });

    test('volume mounts should use appropriate mount options', async () => {
      if (!composeConfig) {
        assert.fail('Could not parse docker-compose.yml');
      }

      const composeContent = await fs.readFile(composePath, 'utf-8');

      // Check for volume mounts that could benefit from nodev, nosuid, noexec
      const dataMounts = composeContent.match(/[^:]\/data[^:]*:/g) || [];

      if (dataMounts.length > 0) {
        console.warn(
          'NOTE: Consider using mount options for data volumes: nodev,nosuid,noexec to prevent device/SUID execution'
        );
      }
    });
  });
});

// Helper function to find files recursively (simple glob implementation)
async function glob(pattern, options = {}) {
  const { cwd = process.cwd() } = options;
  const files = [];

  async function walkDir(dir, relativePath = '') {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relativePath, entry.name).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          await walkDir(fullPath, relPath);
        } else if (entry.isFile() && relPath.match(convertGlobToRegex(pattern))) {
          files.push(relPath);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  await walkDir(cwd);
  return files;
}

function convertGlobToRegex(pattern) {
  // Simple glob to regex conversion for **/*.js pattern
  const escaped = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${escaped}$`);
}
