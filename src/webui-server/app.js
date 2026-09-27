import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../utils/logger.js';
import { securityHeaders } from './middleware/security.js';
import { staticMiddleware, publicPath } from './middleware/static.js';
import proxyRoutes from './routes/proxy.js';
import operationsRoutes, { setSseClients } from './routes/operations.js';
import usersRoutes from './routes/users.js';
import logsRoutes from './routes/logs.js';
import moderationRoutes from './routes/moderation.js';
import bansRoutes from './routes/bans.js';
import alertsRoutes from './routes/alerts.js';
import settingsRoutes from './routes/settings.js';
import botStatusRoutes from './routes/bot-status.js';
import { handleSseConnection } from './sse/handlers.js';

const logger = createLogger('webui');

// Rate limiter for file-serving routes to prevent abuse
const fileServerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'too many requests, please try again later',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Rate limiter for API routes - all handlers hit the database, so every request has a cost.
// Generous limit: the dashboard gets live data over SSE after the initial load.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // Limit each IP to 300 API requests per minute
  message: 'too many requests, please try again later',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

export function createApp(sseClients) {
  const app = express();

  // Security headers middleware
  app.use(securityHeaders);

  // Serve static files
  app.use(staticMiddleware);

  // Dashboard route - rate limited to prevent abuse
  app.get('/', fileServerLimiter, (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  // Rate limit all API routes
  app.use('/api', apiLimiter);

  // SSE stream - live updates for the dashboard
  app.get('/api/events', (req, res) => {
    handleSseConnection(req, res, sseClients);
  });

  // Register routes
  app.use(proxyRoutes);
  app.use(operationsRoutes);
  app.use(usersRoutes);
  app.use(logsRoutes);
  app.use(moderationRoutes);
  app.use(bansRoutes);
  app.use(alertsRoutes);
  app.use(settingsRoutes);
  app.use(botStatusRoutes);

  // Set SSE clients in operations routes for broadcasting
  if (sseClients) {
    setSseClients(sseClients);
  }

  // SPA fallback - serve index.html for all non-API, non-asset routes
  // This must be placed AFTER all API routes so they are matched first
  // Rate limited to prevent abuse
  // Express 5 uses /*splat syntax for wildcard routes
  app.get('/*splat', fileServerLimiter, (req, res) => {
    // Skip if this is an API route or asset request (shouldn't reach here, but safety check)
    if (req.path.startsWith('/api') || req.path.startsWith('/assets')) {
      return res.status(404).json({ error: 'not found' });
    }
    // Serve index.html for SPA routing
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  // Handle errors
  app.on('error', error => {
    logger.error('WebUI error:', error);
  });

  return app;
}
