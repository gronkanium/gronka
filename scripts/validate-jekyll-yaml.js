#!/usr/bin/env node

/**
 * Validates YAML front matter in Jekyll blog posts
 * Checks for common YAML syntax errors that prevent posts from appearing
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

/**
 * Extract YAML front matter from markdown file
 */
function extractFrontMatter(content) {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontMatterRegex);
  return match ? match[1] : null;
}

/**
 * Check if a YAML value needs quoting (contains colons, pipes, or other special chars)
 */
function needsQuoting(value) {
  if (typeof value !== 'string') return false;
  // Check for colons not followed by space (which would be YAML mapping)
  // Also check for pipes, angle brackets, and other YAML special characters
  return (
    /:\s*[^:\s]/.test(value) || /[|>]/.test(value) || value.includes('[') || value.includes(']')
  );
}

/**
 * Validate YAML front matter
 */
function validateFrontMatter(frontMatter) {
  const errors = [];
  const lines = frontMatter.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check for key: value pairs
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();

    // Skip if it's a list item (starts with -)
    if (key.startsWith('-')) continue;

    // Check if value contains a colon and isn't quoted
    if (
      value &&
      needsQuoting(value) &&
      !(value.startsWith('"') && value.endsWith('"')) &&
      !(value.startsWith("'") && value.endsWith("'"))
    ) {
      errors.push({
        line: i + 1,
        key,
        value,
        message: `YAML value for "${key}" contains special characters (like colons) and should be quoted. Found: "${value}"`,
      });
    }
  }

  return errors;
}

/**
 * Validate a single blog post file
 */
function validatePostFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return { valid: false, errors: [`File not found: ${filePath}`] };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const frontMatter = extractFrontMatter(content);

    if (!frontMatter) {
      return { valid: false, errors: ['No YAML front matter found (missing --- delimiters)'] };
    }

    const errors = validateFrontMatter(frontMatter);

    if (errors.length > 0) {
      return { valid: false, errors: errors.map(e => `Line ${e.line}: ${e.message}`) };
    }

    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [`Error reading file: ${error.message}`] };
  }
}

/**
 * Main validation function
 */
function validateJekyllPosts(files = null) {
  const postsDir = join(PROJECT_ROOT, '_posts');

  let filesToCheck = [];

  if (files && files.length > 0) {
    // Validate specific files
    filesToCheck = files.map(f => {
      if (f.startsWith('_posts/')) {
        return join(PROJECT_ROOT, f);
      }
      return f;
    });
  } else {
    // Validate all posts
    if (!existsSync(postsDir)) {
      console.log('No _posts directory found, skipping validation');
      return { valid: true, errors: [] };
    }

    const postFiles = readdirSync(postsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => join(postsDir, f));

    filesToCheck = postFiles;
  }

  if (filesToCheck.length === 0) {
    return { valid: true, errors: [] };
  }

  const allErrors = [];

  for (const filePath of filesToCheck) {
    const result = validatePostFile(filePath);
    if (!result.valid) {
      const relativePath = filePath.replace(PROJECT_ROOT + '/', '');
      allErrors.push({
        file: relativePath,
        errors: result.errors,
      });
    }
  }

  if (allErrors.length > 0) {
    console.error('\n✗ Jekyll YAML validation failed:\n');
    for (const { file, errors } of allErrors) {
      console.error(`  ${file}:`);
      for (const error of errors) {
        console.error(`    - ${error}`);
      }
    }
    console.error('\nFix: Quote YAML values that contain colons or other special characters.\n');
    return { valid: false, errors: allErrors };
  }

  return { valid: true, errors: [] };
}

// Run if called directly
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]);

if (isMainModule) {
  const files = process.argv.slice(2);
  const result = validateJekyllPosts(files.length > 0 ? files : null);
  process.exit(result.valid ? 0 : 1);
}

export { validateJekyllPosts, validatePostFile };
