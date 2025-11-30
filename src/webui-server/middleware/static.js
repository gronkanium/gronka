import path from 'path';
import express from 'express';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

// Get absolute path to public directory
const publicPath = path.resolve(process.cwd(), 'src', 'public');
logger.debug(`Serving static files from: ${publicPath}`);

// Serve static files from public directory with explicit MIME type configuration
export const staticMiddleware = express.static(publicPath, {
  setHeaders: (res, filePath) => {
    // Explicitly set MIME types for CSS and JS files to prevent MIME type issues
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  },
  // Use fallthrough: true to allow API routes and other handlers to work
  // Static files will be served if they exist, otherwise request continues to next middleware
  fallthrough: true,
});

export { publicPath };
