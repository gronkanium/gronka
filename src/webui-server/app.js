import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../utils/logger.js';
import { securityHeaders } from './middleware/security.js';
import { staticMiddleware, publicPath } from './middleware/static.js';
import proxyRoutes from './routes/proxy.js';
import operationsRoutes, { setWebSocketClients } from './routes/operations.js';
import usersRoutes from './routes/users.js';
import logsRoutes from './routes/logs.js';
import moderationRoutes from './routes/moderation.js';
import metricsRoutes from './routes/metrics.js';
import alertsRoutes from './routes/alerts.js';

const logger = createLogger('webui');

// Rate limiter for file-serving routes to prevent abuse
const fileServerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'too many requests, please try again later',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

export function createApp(websocketClients) {
  const app = express();

  // Security headers middleware
  app.use(securityHeaders);

  // Serve static files
  app.use(staticMiddleware);

  // Dashboard route - rate limited to prevent abuse
  app.get('/', fileServerLimiter, (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  // Register routes
  app.use(proxyRoutes);
  app.use(operationsRoutes);
  app.use(usersRoutes);
  app.use(logsRoutes);
  app.use(moderationRoutes);
  app.use(metricsRoutes);
  app.use(alertsRoutes);

  // Set WebSocket clients in operations routes for broadcasting
  if (websocketClients) {
    setWebSocketClients(websocketClients);
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
