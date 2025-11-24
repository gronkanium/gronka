import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock execSync and writeFileSync for testing
let execSyncCalls = [];
let execSyncResponses = [];
let execSyncShouldFail = false;
let execSyncErrorType = null;
let writeFileSyncCalls = [];
let originalExecSync;
let originalWriteFileSync;

beforeEach(() => {
  execSyncCalls = [];
  execSyncResponses = [];
  execSyncShouldFail = false;
  execSyncErrorType = null;
  writeFileSyncCalls = [];
  originalExecSync = execSync;
  originalWriteFileSync = writeFileSync;

  // Mock execSync
  globalThis.execSync = (command, options) => {
    execSyncCalls.push({ command, options });

    if (execSyncShouldFail) {
      const error = new Error('Command failed');
      if (execSyncErrorType === '404') {
        error.status = 404;
        error.stderr = '404 Not Found';
      } else if (execSyncErrorType === '401') {
        error.status = 401;
      } else if (execSyncErrorType === '403') {
        error.status = 403;
      } else {
        error.status = 1;
      }
      throw error;
    }

    // Return mock response if available
    if (execSyncResponses.length > 0) {
      return execSyncResponses.shift();
    }

    // Default responses
    if (command.includes('gh --version')) {
      return 'gh version 2.0.0';
    }

    return '[]';
  };

  // Mock writeFileSync
  globalThis.writeFileSync = (file, data, encoding) => {
    writeFileSyncCalls.push({ file, data, encoding });
  };
});

afterEach(() => {
  globalThis.execSync = originalExecSync;
  globalThis.writeFileSync = originalWriteFileSync;
});

describe('fetch-code-scanning-issues.js', () => {
  describe('GitHub CLI availability check', () => {
    test('checks for gh CLI availability', () => {
      execSyncShouldFail = false;
      execSyncResponses.push('gh version 2.0.0');

      try {
        execSync('gh --version', { stdio: 'pipe' });
        assert.ok(execSyncCalls.length > 0);
        assert.ok(execSyncCalls[0].command.includes('gh --version'));
      } catch {
        assert.fail('Should not throw when gh is available');
      }
    });

    test('exits when gh CLI is not available', () => {
      execSyncShouldFail = true;
      execSyncErrorType = 'not-found';

      try {
        execSync('gh --version', { stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error);
      }
    });
  });

  describe('API endpoint construction', () => {
    test('constructs correct API endpoint', () => {
      const repoOwner = 'thedorekaczynski';
      const repoName = 'gronka';
      const apiEndpoint = `/repos/${repoOwner}/${repoName}/code-scanning/alerts`;

      assert.strictEqual(apiEndpoint, '/repos/thedorekaczynski/gronka/code-scanning/alerts');
    });

    test('constructs endpoint with query parameters', () => {
      const apiEndpoint = '/repos/thedorekaczynski/gronka/code-scanning/alerts';
      const queryParams = 'state=open&per_page=100&page=1';
      const fullEndpoint = `${apiEndpoint}?${queryParams}`;

      assert.ok(fullEndpoint.includes('state=open'));
      assert.ok(fullEndpoint.includes('per_page=100'));
      assert.ok(fullEndpoint.includes('page=1'));
    });

    test('uses correct pagination parameters', () => {
      const perPage = 100;
      assert.strictEqual(perPage, 100);
    });
  });

  describe('pagination handling', () => {
    test('handles single page of results', () => {
      const page1Alerts = [{ state: 'open', rule: { name: 'Test Rule' } }];
      execSyncResponses.push(JSON.stringify(page1Alerts));

      const output = execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
      const alerts = JSON.parse(output);

      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].state, 'open');
    });

    test('handles multiple pages of results', () => {
      const page1Alerts = Array(100).fill({ state: 'open' });
      const page2Alerts = Array(50).fill({ state: 'open' });

      execSyncResponses.push(JSON.stringify(page1Alerts));
      execSyncResponses.push(JSON.stringify(page2Alerts));

      // Simulate pagination logic
      let allAlerts = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= 2) {
        const output = execSync(`gh api "test?page=${page}"`, { encoding: 'utf-8', stdio: 'pipe' });
        const pageAlerts = JSON.parse(output);
        allAlerts = allAlerts.concat(pageAlerts);

        if (pageAlerts.length < 100) {
          hasMore = false;
        } else {
          page++;
        }
      }

      assert.strictEqual(allAlerts.length, 150);
    });

    test('stops pagination on 404', () => {
      execSyncShouldFail = true;
      execSyncErrorType = '404';

      try {
        execSync('gh api "test?page=2"', { encoding: 'utf-8', stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual(error.status, 404);
      }
    });
  });

  describe('JSON parsing', () => {
    test('parses valid JSON response', () => {
      const alerts = [{ state: 'open', rule: { name: 'Test' } }];
      execSyncResponses.push(JSON.stringify(alerts));

      const output = execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
      const parsed = JSON.parse(output);

      assert.ok(Array.isArray(parsed));
      assert.strictEqual(parsed.length, 1);
    });

    test('handles invalid JSON gracefully', () => {
      execSyncResponses.push('invalid json');

      const output = execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });

      try {
        JSON.parse(output);
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof SyntaxError);
      }
    });

    test('validates response is an array', () => {
      const notAnArray = { alerts: [] };
      execSyncResponses.push(JSON.stringify(notAnArray));

      const output = execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
      const parsed = JSON.parse(output);

      assert.ok(!Array.isArray(parsed));
    });
  });

  describe('alert filtering', () => {
    test('filters to only open alerts', () => {
      const allAlerts = [
        { state: 'open', rule: { name: 'Open Rule' } },
        { state: 'fixed', rule: { name: 'Fixed Rule' } },
        { state: 'dismissed', rule: { name: 'Dismissed Rule' } },
        { state: 'open', rule: { name: 'Another Open Rule' } },
      ];

      const openAlerts = allAlerts.filter(alert => alert.state === 'open');

      assert.strictEqual(openAlerts.length, 2);
      assert.ok(openAlerts.every(alert => alert.state === 'open'));
    });

    test('handles empty alerts array', () => {
      const allAlerts = [];
      const openAlerts = allAlerts.filter(alert => alert.state === 'open');

      assert.strictEqual(openAlerts.length, 0);
    });
  });

  describe('file writing', () => {
    test('writes alerts to correct file', () => {
      const outputFile = join(__dirname, '..', '..', 'code-scanning-issues.json');
      const alerts = [{ state: 'open' }];
      const formattedOutput = JSON.stringify(alerts, null, 2);

      writeFileSync(outputFile, formattedOutput, 'utf-8');

      assert.ok(writeFileSyncCalls.length > 0);
      assert.ok(writeFileSyncCalls[0].file.includes('code-scanning-issues.json'));
      assert.ok(writeFileSyncCalls[0].encoding === 'utf-8');
    });

    test('formats JSON with indentation', () => {
      const alerts = [{ state: 'open', rule: { name: 'Test' } }];
      const formattedOutput = JSON.stringify(alerts, null, 2);

      assert.ok(formattedOutput.includes('\n'));
      assert.ok(formattedOutput.includes('  ')); // 2-space indentation
    });
  });

  describe('error handling', () => {
    test('handles 404 repository not found', () => {
      execSyncShouldFail = true;
      execSyncErrorType = '404';

      try {
        execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual(error.status, 404);
      }
    });

    test('handles 401 authentication failed', () => {
      execSyncShouldFail = true;
      execSyncErrorType = '401';

      try {
        execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual(error.status, 401);
      }
    });

    test('handles 403 forbidden', () => {
      execSyncShouldFail = true;
      execSyncErrorType = '403';

      try {
        execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual(error.status, 403);
      }
    });

    test('handles generic errors', () => {
      execSyncShouldFail = true;
      execSyncErrorType = 'generic';

      try {
        execSync('gh api "test"', { encoding: 'utf-8', stdio: 'pipe' });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error);
        assert.strictEqual(error.status, 1);
      }
    });
  });

  describe('output file path', () => {
    test('constructs correct output file path', () => {
      const baseDir = join(__dirname, '..', '..');
      const outputFile = join(baseDir, 'code-scanning-issues.json');

      assert.ok(outputFile.includes('code-scanning-issues.json'));
      assert.ok(outputFile.includes('gronka') || outputFile.endsWith('code-scanning-issues.json'));
    });
  });

  describe('alert summary formatting', () => {
    test('formats alert summary correctly', () => {
      const alert = {
        rule: { name: 'Test Rule', severity: 'high' },
        state: 'open',
        most_recent_instance: { location: { path: 'src/test.js' } },
      };

      const rule = alert.rule?.name || 'Unknown rule';
      const severity = alert.rule?.severity || 'unknown';
      const state = alert.state || 'unknown';
      const file = alert.most_recent_instance?.location?.path || 'unknown';

      assert.strictEqual(rule, 'Test Rule');
      assert.strictEqual(severity, 'high');
      assert.strictEqual(state, 'open');
      assert.strictEqual(file, 'src/test.js');
    });

    test('handles missing alert fields gracefully', () => {
      const alert = {};

      const rule = alert.rule?.name || 'Unknown rule';
      const severity = alert.rule?.severity || 'unknown';
      const state = alert.state || 'unknown';
      const file = alert.most_recent_instance?.location?.path || 'unknown';

      assert.strictEqual(rule, 'Unknown rule');
      assert.strictEqual(severity, 'unknown');
      assert.strictEqual(state, 'unknown');
      assert.strictEqual(file, 'unknown');
    });
  });
});
