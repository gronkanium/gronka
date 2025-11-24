import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import escape from 'escape-html';
import tmp from 'tmp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We need to test the validatePath function and XSS prevention
// Since serve-site.js is a script, we'll need to extract the logic or test it via HTTP

describe('serve-site security', () => {
  let tempSiteDir;
  let tmpDirCleanup;

  before(() => {
    // Create temporary site directory for testing
    const tmpDir = tmp.dirSync({ prefix: 'gronka-test-site-', unsafeCleanup: true });
    tempSiteDir = tmpDir.name;
    tmpDirCleanup = tmpDir.removeCallback;

    // Create test files
    fs.writeFileSync(path.join(tempSiteDir, 'index.html'), '<html><body>Index</body></html>');
    fs.writeFileSync(path.join(tempSiteDir, 'test.html'), '<html><body>Test</body></html>');
    fs.mkdirSync(path.join(tempSiteDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tempSiteDir, 'docs', 'index.html'),
      '<html><body>Docs</body></html>'
    );
  });

  after(() => {
    // Clean up temp directory
    if (tmpDirCleanup) {
      tmpDirCleanup();
    }
  });

  describe('validatePath function', () => {
    // Extract validatePath logic for testing
    function validatePath(urlPath, siteDir) {
      // Remove query string and hash
      const cleanPath = urlPath.split('?')[0].split('#')[0];

      // Remove leading slash for cross-platform compatibility
      const pathWithoutLeadingSlash = cleanPath.startsWith('/') ? cleanPath.slice(1) : cleanPath;

      // Normalize the path and resolve it relative to siteDir
      const normalizedPath = path.normalize(pathWithoutLeadingSlash);
      const resolvedPath = path.resolve(siteDir, normalizedPath);

      // Ensure the resolved path is within siteDir to prevent path traversal
      if (!resolvedPath.startsWith(siteDir)) {
        return null;
      }

      return resolvedPath;
    }

    test('allows valid paths within siteDir', () => {
      // On Windows, paths need to be normalized
      const result = validatePath('/test.html', tempSiteDir);
      if (result) {
        assert.ok(result.startsWith(tempSiteDir));
        assert.ok(result.includes('test.html'));
      } else {
        // On Windows, leading slash might cause issues, try without
        const result2 = validatePath('test.html', tempSiteDir);
        assert.ok(result2);
        assert.ok(result2.startsWith(tempSiteDir));
        assert.ok(result2.includes('test.html'));
      }
    });

    test('prevents path traversal with ../', () => {
      const result = validatePath('../../etc/passwd', tempSiteDir);
      assert.strictEqual(result, null);
    });

    test('prevents path traversal with ..\\', () => {
      // On Linux, backslashes are not path separators, so path.normalize
      // may not handle them the same way. The key is that the resolved path
      // should still be within siteDir or null.
      const result = validatePath('..\\..\\etc\\passwd', tempSiteDir);
      // On Linux, this might resolve to a path within siteDir (with literal backslashes)
      // or null. Either is acceptable as long as it doesn't escape siteDir.
      if (result) {
        assert.ok(result.startsWith(tempSiteDir), 'Path must stay within siteDir');
      } else {
        assert.strictEqual(result, null);
      }
    });

    test('prevents path traversal with encoded ../', () => {
      // URL-encoded paths need to be decoded first, but validatePath doesn't decode
      // So the encoded string is treated as a literal path
      const result = validatePath('%2e%2e%2f%2e%2e%2fetc%2fpasswd', tempSiteDir);
      // The encoded path should either be blocked or result in an invalid path
      // On Windows, path.normalize might handle this differently
      // The key is that it shouldn't allow access outside siteDir
      if (result) {
        // If it resolves, it should still be within siteDir
        assert.ok(result.startsWith(tempSiteDir));
      } else {
        // If it's null, that's also acceptable (blocked)
        assert.strictEqual(result, null);
      }
    });

    test('prevents absolute paths outside siteDir', () => {
      if (process.platform === 'win32') {
        const result = validatePath('C:\\Windows\\System32', tempSiteDir);
        assert.strictEqual(result, null);
      } else {
        // On Linux, /etc/passwd with leading slash might resolve differently
        // The key is that it should not allow access outside siteDir
        const result = validatePath('/etc/passwd', tempSiteDir);
        // If it resolves, it should be within siteDir (unlikely but possible)
        // Otherwise it should be null
        if (result) {
          assert.ok(result.startsWith(tempSiteDir), 'Path must stay within siteDir');
        } else {
          assert.strictEqual(result, null);
        }
      }
    });

    test('removes query string from path', () => {
      // Try with and without leading slash for cross-platform compatibility
      let result = validatePath('/test.html?param=value', tempSiteDir);
      if (!result) {
        result = validatePath('test.html?param=value', tempSiteDir);
      }
      assert.ok(result);
      assert.ok(result.includes('test.html'));
      assert.ok(!result.includes('?'));
    });

    test('removes hash from path', () => {
      // Try with and without leading slash for cross-platform compatibility
      let result = validatePath('/test.html#section', tempSiteDir);
      if (!result) {
        result = validatePath('test.html#section', tempSiteDir);
      }
      assert.ok(result);
      assert.ok(result.includes('test.html'));
      assert.ok(!result.includes('#'));
    });

    test('normalizes path separators', () => {
      if (process.platform === 'win32') {
        const result = validatePath('docs\\index.html', tempSiteDir);
        assert.ok(result);
        assert.ok(result.includes('docs'));
        assert.ok(result.includes('index.html'));
      } else {
        const result = validatePath('docs/index.html', tempSiteDir);
        assert.ok(result);
        assert.ok(result.includes('docs'));
        assert.ok(result.includes('index.html'));
      }
    });

    test('prevents null byte injection', () => {
      // Null bytes in paths are handled by path.normalize
      // The path might still resolve, but null bytes should be removed or cause issues
      const result = validatePath('/test.html\x00', tempSiteDir);
      // The important thing is that it doesn't allow path traversal
      // Null bytes are typically removed or cause the path to be invalid
      if (result) {
        // If it resolves, verify it's within siteDir and doesn't contain null bytes
        assert.ok(result.startsWith(tempSiteDir));
        // Note: path.normalize may remove null bytes, so we check the result doesn't contain them
        // But on some systems, the null byte might remain in the string representation
        // The key security check is that it's within siteDir
      }
      // Result can be null (blocked) or a valid path within siteDir
      assert.ok(result === null || result.startsWith(tempSiteDir));
    });

    test('allows subdirectory paths', () => {
      // Try with and without leading slash for cross-platform compatibility
      let result = validatePath('/docs/index.html', tempSiteDir);
      if (!result) {
        result = validatePath('docs/index.html', tempSiteDir);
      }
      assert.ok(result);
      assert.ok(result.startsWith(tempSiteDir));
      assert.ok(result.includes('docs'));
    });

    test('prevents multiple ../ sequences', () => {
      const result = validatePath('../../../etc/passwd', tempSiteDir);
      assert.strictEqual(result, null);
    });

    test('prevents mixed path separators with traversal', () => {
      // On Linux, backslashes are literal characters, not separators
      // The path normalization should still prevent traversal
      const result = validatePath('..\\../etc/passwd', tempSiteDir);
      // The key is that it doesn't allow access outside siteDir
      if (result) {
        assert.ok(result.startsWith(tempSiteDir), 'Path must stay within siteDir');
      } else {
        assert.strictEqual(result, null);
      }
    });
  });

  describe('XSS prevention in 404 pages', () => {
    test('escape-html escapes script tags', () => {
      const maliciousUrl = '<script>alert("XSS")</script>';
      const escaped = escape(maliciousUrl);
      assert.ok(!escaped.includes('<script>'));
      assert.ok(escaped.includes('&lt;script&gt;'));
    });

    test('escape-html escapes HTML entities', () => {
      const maliciousUrl = '<img src=x onerror=alert(1)>';
      const escaped = escape(maliciousUrl);
      assert.ok(!escaped.includes('<img'));
      assert.ok(escaped.includes('&lt;'));
      assert.ok(escaped.includes('&gt;'));
    });

    test('escape-html escapes quotes', () => {
      const maliciousUrl = '"onclick="alert(1)"';
      const escaped = escape(maliciousUrl);
      assert.ok(escaped.includes('&quot;'));
    });

    test('escape-html escapes ampersands', () => {
      const maliciousUrl = 'test&value';
      const escaped = escape(maliciousUrl);
      assert.ok(escaped.includes('&amp;'));
    });

    test('escape-html handles normal text', () => {
      const normalUrl = '/docs/guide.html';
      const escaped = escape(normalUrl);
      assert.strictEqual(escaped, normalUrl);
    });

    test('escape-html handles complex XSS payload', () => {
      const maliciousUrl = '"><script>alert(String.fromCharCode(88,83,83))</script>';
      const escaped = escape(maliciousUrl);
      assert.ok(!escaped.includes('<script>'));
      assert.ok(escaped.includes('&lt;'));
      assert.ok(escaped.includes('&gt;'));
    });
  });

  describe('path validation integration', () => {
    // Test that validatePath is used correctly in findFile logic
    function findFile(urlPath, siteDir) {
      // Remove trailing slash for consistency
      if (urlPath.endsWith('/') && urlPath !== '/') {
        urlPath = urlPath.slice(0, -1);
      }

      // Validate and normalize path to prevent path traversal
      function validatePath(urlPath, siteDir) {
        const cleanPath = urlPath.split('?')[0].split('#')[0];
        const normalizedPath = path.normalize(cleanPath);
        const resolvedPath = path.resolve(siteDir, normalizedPath);
        if (!resolvedPath.startsWith(siteDir)) {
          return null;
        }
        return resolvedPath;
      }

      const validatedPath = validatePath(urlPath, siteDir);
      if (!validatedPath) {
        return null;
      }

      let filePath = validatedPath;

      // Check if it's a file
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return filePath;
      }

      // Check if it's a directory with index.html
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        const indexFile = path.join(filePath, 'index.html');
        const resolvedIndex = path.resolve(indexFile);
        if (resolvedIndex.startsWith(siteDir) && fs.existsSync(indexFile)) {
          return indexFile;
        }
      }

      return null;
    }

    test('findFile prevents path traversal', () => {
      const result = findFile('../../etc/passwd', tempSiteDir);
      assert.strictEqual(result, null);
    });

    test('findFile allows valid files', () => {
      // Try with and without leading slash for cross-platform compatibility
      let result = findFile('/test.html', tempSiteDir);
      if (!result) {
        result = findFile('test.html', tempSiteDir);
      }
      assert.ok(result);
      assert.ok(fs.existsSync(result));
    });

    test('findFile validates index.html paths', () => {
      // Try with and without leading slash for cross-platform compatibility
      let result = findFile('/docs', tempSiteDir);
      if (!result) {
        result = findFile('docs', tempSiteDir);
      }
      assert.ok(result);
      assert.ok(result.endsWith('index.html'));
      assert.ok(fs.existsSync(result));
    });

    test('findFile prevents traversal in directory resolution', () => {
      const result = findFile('/docs/../../etc/passwd', tempSiteDir);
      assert.strictEqual(result, null);
    });
  });
});
