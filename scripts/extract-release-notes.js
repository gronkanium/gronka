import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const changelogPath = process.argv[2] || 'CHANGELOG.md';
const version = process.argv[3];

if (!version) {
  console.error('Usage: node extract-release-notes.js <changelog-path> <version>');
  process.exit(1);
}

// Remove 'v' prefix if present
const cleanVersion = version.startsWith('v') ? version.substring(1) : version;

try {
  const content = fs.readFileSync(changelogPath, 'utf8');
  const lines = content.split('\n');

  let capturing = false;
  let notes = [];

  // Regex to match the version header.
  // Matches: ## [1.0.0] or ## 1.0.0
  // We want to be somewhat flexible but accurate.
  // Escape all regex special characters to prevent regex injection
  const escapedVersion = cleanVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionRegex = new RegExp(`^##\\s+\\[?${escapedVersion}\\]?`);

  // Regex to match the start of the NEXT version section
  // Matches any line starting with ## followed by text (not strictly ###)
  // But wait, ## [Unreleased] is also a section.
  // Generally, any line starting with ## (but not ###) ends the section.
  const nextSectionRegex = /^##\s+/;

  for (const line of lines) {
    if (capturing) {
      // Check if this line starts a new version section
      if (nextSectionRegex.test(line)) {
        break;
      }
      notes.push(line);
    } else {
      if (versionRegex.test(line)) {
        capturing = true;
        // logic to skip the header line itself if we don't want it,
        // but typically release notes *might* include the title?
        // GitHub Release body usually gets just the content.
        // The previous awk script included the header (start of range), so let's exclude it to be cleaner.
        // The user wants "release notes", usually that means the bullet points.
        // Let's NOT include the header line.
      }
    }
  }

  if (notes.length > 0) {
    // Trim leading/trailing empty lines
    let result = notes.join('\n').trim();
    console.log(result);
  } else {
    // If we found nothing (maybe version not in changelog), we exit with empty output
    // The workflow checks for empty output to trigger fallback.
    process.exit(0);
  }
} catch (error) {
  console.error(`Error reading changelog: ${error.message}`);
  process.exit(1);
}
