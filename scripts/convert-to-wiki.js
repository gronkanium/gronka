import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const docsDir = path.join(projectRoot, '_docs');
const wikiDir = path.join(projectRoot, 'wiki');

// Mapping of original filenames to wiki page names
const filenameMap = {
  'quick-start.md': 'Quick-Start',
  'installation.md': 'Installation',
  'commands.md': 'Commands',
  'configuration.md': 'Configuration',
  'docker.md': 'Docker-Deployment',
  'docker-quick-reference.md': 'Docker-Quick-Reference',
  'r2-storage.md': 'R2-Storage',
  'cobalt-integration.md': 'Cobalt-Integration',
  'api-endpoints.md': 'API-Endpoints',
  'troubleshooting.md': 'Troubleshooting',
  'logging-platform.md': 'Logging-Platform',
  'guide.md': 'Technical-Specification',
};

// Reverse mapping for link conversion (reserved for future use)
const _pageNameToFilename = Object.fromEntries(
  Object.entries(filenameMap).map(([file, page]) => [page, file.replace('.md', '')])
);

/**
 * Strip Jekyll frontmatter from markdown content
 */
function stripFrontmatter(content) {
  // Remove frontmatter (lines between --- markers at the start)
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  return content.replace(frontmatterRegex, '').trim();
}

/**
 * Convert kebab-case to Title Case
 */
function toTitleCase(str) {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('-');
}

/**
 * Get wiki page name from path
 */
function getPageNameFromPath(pagePath) {
  // Remove leading/trailing slashes and get basename
  const cleanPath = pagePath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .pop();
  // Check if we have a mapping
  const mappedName = filenameMap[`${cleanPath}.md`];
  if (mappedName) return mappedName;
  // Otherwise convert to Title Case
  return toTitleCase(cleanPath);
}

/**
 * Convert Jekyll-style links to GitHub Wiki links
 */
function convertLinks(content, _currentPageName) {
  // First, convert markdown links like [text](/docs/page/) to wiki links
  // This handles both with and without text
  content = content.replace(/\[([^\]]*)\]\(\/docs\/([^/)]+)\/?\)/g, (match, text, pagePath) => {
    const pageName = getPageNameFromPath(pagePath);
    // If there's link text, use pipe syntax, otherwise just the page name
    if (text && text.trim()) {
      return `[[${pageName}|${text}]]`;
    }
    return `[[${pageName}]]`;
  });

  // Convert bare /docs/page-name/ links (without markdown syntax)
  content = content.replace(/\/docs\/([^/\s)]+)\/?/g, (match, pagePath) => {
    const pageName = getPageNameFromPath(pagePath);
    return `[[${pageName}]]`;
  });

  return content;
}

/**
 * Convert filename to wiki page name
 */
function getWikiPageName(filename) {
  const basename = path.basename(filename, '.md');
  return (
    filenameMap[filename] ||
    basename
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('-')
  );
}

/**
 * Process a single markdown file
 */
function processFile(filePath) {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');

  // Strip frontmatter
  let wikiContent = stripFrontmatter(content);

  // Get wiki page name for link conversion
  const pageName = getWikiPageName(filename);

  // Convert links
  wikiContent = convertLinks(wikiContent, pageName);

  // Get output filename
  const wikiPageName = getWikiPageName(filename);
  const outputPath = path.join(wikiDir, `${wikiPageName}.md`);

  return {
    outputPath,
    content: wikiContent,
    pageName: wikiPageName,
  };
}

/**
 * Main conversion function
 */
function convertDocs() {
  // Create wiki directory if it doesn't exist
  if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  // Get all markdown files from _docs
  const files = fs
    .readdirSync(docsDir)
    .filter(file => file.endsWith('.md'))
    .map(file => path.join(docsDir, file));

  const processedPages = [];

  console.log('Converting documentation files...\n');

  for (const filePath of files) {
    try {
      const result = processFile(filePath);
      fs.writeFileSync(result.outputPath, result.content, 'utf-8');
      processedPages.push(result.pageName);
      console.log(`✓ Converted: ${path.basename(filePath)} → ${result.pageName}.md`);
    } catch (error) {
      console.error(`✗ Error processing ${filePath}:`, error.message);
    }
  }

  console.log(`\nConversion complete! Processed ${processedPages.length} files.`);
  return processedPages;
}

// Run conversion if this is the main module
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));

if (isMainModule || process.argv[1]?.includes('convert-to-wiki.js')) {
  convertDocs();
}

export { convertDocs, getWikiPageName, convertLinks, stripFrontmatter };
