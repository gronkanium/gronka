#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteDir = path.join(__dirname, '..', '_site');
const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';

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

  let filePath = path.join(siteDir, urlPath);

  // Check if it's a file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }

  // Check if it's a directory with index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const indexFile = path.join(filePath, 'index.html');
    if (fs.existsSync(indexFile)) {
      return indexFile;
    }
  }

  // Check for index.html in directory (for /docs/guide -> /docs/guide/index.html)
  const indexFile = path.join(siteDir, urlPath, 'index.html');
  if (fs.existsSync(indexFile)) {
    return indexFile;
  }

  // Check for .html file (for /docs/guide -> /docs/guide.html)
  const htmlFile = path.join(siteDir, urlPath + '.html');
  if (fs.existsSync(htmlFile)) {
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
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>404 Not Found</title></head>
        <body><h1>404 Not Found</h1><p>The requested URL ${req.url} was not found.</p></body>
      </html>
    `);
  }
});

server.listen(port, host, () => {
  console.log(`Static file server running at http://${host}:${port}`);
  console.log(`Serving files from: ${siteDir}`);
});
