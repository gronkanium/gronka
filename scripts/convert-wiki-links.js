#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const wikiDir = path.join(projectRoot, 'wiki');

/**
 * Convert Obsidian-style wiki links to GitHub Wiki format
 * - [[Page-Name]] → [Page-Name](Page-Name)
 * - [[Page-Name|text]] → [text](Page-Name)
 */
function convertWikiLinks(content) {
  // Convert [[Page-Name|text]] format to [text](Page-Name)
  content = content.replace(/\[\[([^|]+)\|([^\]]+)\]\]/g, (match, pageName, linkText) => {
    return `[${linkText.trim()}](${pageName.trim()})`;
  });

  // Convert [[Page-Name]] format to [Page-Name](Page-Name)
  content = content.replace(/\[\[([^\]]+)\]\]/g, (match, pageName) => {
    return `[${pageName.trim()}](${pageName.trim()})`;
  });

  return content;
}

/**
 * Convert a single wiki file from Obsidian format to GitHub Wiki format
 */
function convertWikiFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const converted = convertWikiLinks(content);
  return converted;
}

/**
 * Convert all wiki files in the wiki directory
 */
function convertAllWikiFiles() {
  if (!fs.existsSync(wikiDir)) {
    throw new Error(`Wiki directory not found: ${wikiDir}`);
  }

  const files = fs
    .readdirSync(wikiDir)
    .filter(file => file.endsWith('.md'))
    .map(file => path.join(wikiDir, file));

  const converted = {};

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const convertedContent = convertWikiFile(filePath);
    converted[filename] = convertedContent;
  }

  return converted;
}

// Export functions for use in other scripts
export { convertWikiLinks, convertWikiFile, convertAllWikiFiles };

// Run conversion if this is the main module
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));

if (isMainModule) {
  try {
    const converted = convertAllWikiFiles();
    console.log(`✓ Converted ${Object.keys(converted).length} wiki files`);
    console.log('Files:', Object.keys(converted).join(', '));
  } catch (error) {
    console.error('✗ Error converting wiki files:', error.message);
    process.exit(1);
  }
}
