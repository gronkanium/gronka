#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteDir = path.resolve(path.join(__dirname, '..', '_site'));
const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} HTML-escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') {
    return String(str);
  }
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate and normalize file path to prevent path traversal
 * @param {string} urlPath - URL path from request
 * @returns {string|null} Normalized file path or null if invalid
 */
function validatePath(urlPath) {
  // Remove query string and hash
  const cleanPath = urlPath.split('?')[0].split('#')[0];

  // Normalize the path and resolve it relative to siteDir
  const normalizedPath = path.normalize(cleanPath);
  const resolvedPath = path.resolve(siteDir, normalizedPath);

  // Ensure the resolved path is within siteDir to prevent path traversal
  if (!resolvedPath.startsWith(siteDir)) {
    return null;
  }

  return resolvedPath;
}

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.ico': 'image/x-icon',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
}

function serveFile(filePath, res) {
  // Additional validation: ensure path is still within siteDir
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(siteDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

function findFile(urlPath) {
  // Remove trailing slash for consistency
  if (urlPath.endsWith('/') && urlPath !== '/') {
    urlPath = urlPath.slice(0, -1);
  }

  // Validate and normalize path to prevent path traversal
  const validatedPath = validatePath(urlPath);
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
    // Validate index file path
    const resolvedIndex = path.resolve(indexFile);
    if (resolvedIndex.startsWith(siteDir) && fs.existsSync(indexFile)) {
      return indexFile;
    }
  }

  // Check for index.html in directory (for /docs/guide -> /docs/guide/index.html)
  const indexFile = path.join(filePath, 'index.html');
  const resolvedIndex = path.resolve(indexFile);
  if (resolvedIndex.startsWith(siteDir) && fs.existsSync(indexFile)) {
    return indexFile;
  }

  // Check for .html file (for /docs/guide -> /docs/guide.html)
  const htmlFile = path.join(filePath + '.html');
  const resolvedHtml = path.resolve(htmlFile);
  if (resolvedHtml.startsWith(siteDir) && fs.existsSync(htmlFile)) {
    return htmlFile;
  }

  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  const filePath = findFile(urlPath);

  if (filePath) {
    serveFile(filePath, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    // Escape user input to prevent XSS
    const escapedUrl = escapeHtml(req.url);
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>404 Not Found</title></head>
        <body><h1>404 Not Found</h1><p>The requested URL ${escapedUrl} was not found.</p></body>
      </html>
    `);
  }
});

server.listen(port, host, () => {
  console.log(`Static file server running at http://${host}:${port}`);
  console.log(`Serving files from: ${siteDir}`);
});
