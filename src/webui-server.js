import express from 'express';
import path from 'path';
import axios from 'axios';
import http from 'http';
import { WebSocketServer } from 'ws';
import rateLimit from 'express-rate-limit';
import { createLogger } from './utils/logger.js';
import { webuiConfig } from './utils/config.js';
import { ConfigurationError } from './utils/errors.js';
import { setBroadcastCallback } from './utils/operations-tracker.js';

// In-memory storage for operations (mirror of bot's operations)
const operations = [];
const MAX_OPERATIONS = 100;

// Initialize logger
const logger = createLogger('webui');

// Rate limiter for file-serving routes to prevent abuse
const fileServerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'too many requests, please try again later',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Configuration from centralized config
const {
  webuiPort: WEBUI_PORT,
  webuiHost: WEBUI_HOST,
  mainServerUrl: MAIN_SERVER_URL,
} = webuiConfig;

// Stats auth credentials (optional - only needed if main server requires auth)
const STATS_USERNAME = process.env.STATS_USERNAME || null;
const STATS_PASSWORD = process.env.STATS_PASSWORD || null;

// Build auth header if credentials are provided
function getAuthHeaders() {
  const headers = {};
  if (STATS_USERNAME && STATS_PASSWORD) {
    const credentials = Buffer.from(`${STATS_USERNAME}:${STATS_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}

// Crypto price cache
const CACHE_TTL = 60 * 1000; // 60 seconds
let cryptoPriceCache = {
  data: null,
  timestamp: null,
};

function isCacheValid() {
  if (!cryptoPriceCache.data || !cryptoPriceCache.timestamp) {
    return false;
  }
  return Date.now() - cryptoPriceCache.timestamp < CACHE_TTL;
}

async function fetchCryptoPricesFromAPI() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { timeout: 5000 }
    );
    const data = response.data;
    return {
      bitcoin: data.bitcoin?.usd || null,
      ethereum: data.ethereum?.usd || null,
    };
  } catch (error) {
    logger.error('Failed to fetch crypto prices from CoinGecko:', error);
    throw error;
  }
}

const app = express();

// Security headers middleware
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only include recognized Permissions-Policy features to avoid console warnings
  // Only set well-known, recognized features - omitting Privacy Sandbox features that cause warnings
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  let logged = false;

  // Log response when finished (most reliable method)
  const logResponse = () => {
    if (logged) return;
    logged = true;
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode || 200;
    logger.info(
      `${req.method} ${req.path} - ${statusCode} - ${duration}ms - ${req.ip || req.connection.remoteAddress}`
    );
  };

  // Intercept response methods as backup (in case finish event doesn't fire)
  const originalSend = res.send;
  const originalSendFile = res.sendFile;
  const originalJson = res.json;

  res.send = function (_data) {
    logResponse();
    return originalSend.apply(this, arguments);
  };

  res.sendFile = function (...args) {
    logResponse();
    return originalSendFile.apply(this, args);
  };

  res.json = function (_data) {
    logResponse();
    return originalJson.apply(this, arguments);
  };

  // Primary logging on response finish (catches all cases)
  res.on('finish', logResponse);

  next();
});

// Get absolute path to public directory
const publicPath = path.resolve(process.cwd(), 'src', 'public');
logger.debug(`Serving static files from: ${publicPath}`);

// Serve static files from public directory with explicit MIME type configuration
app.use(
  express.static(publicPath, {
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
  })
);

// Dashboard route - rate limited to prevent abuse
app.get('/', fileServerLimiter, (req, res) => {
  logger.info('Dashboard page requested');
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Proxy endpoint to fetch stats from main server
app.get('/api/stats', async (req, res) => {
  try {
    logger.debug('Fetching stats from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/stats`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch stats from main server:', error);
    res.status(500).json({
      error: 'failed to fetch stats',
      message: error.message,
    });
  }
});

// Proxy endpoint to fetch health from main server
app.get('/api/health', async (req, res) => {
  try {
    logger.debug('Fetching health from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/health`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch health from main server:', error);
    res.status(500).json({
      error: 'failed to fetch health',
      message: error.message,
    });
  }
});

// Endpoint for bot to send operation updates
app.post('/api/operations', express.json(), (req, res) => {
  try {
    const operation = req.body;
    if (!operation || !operation.id) {
      return res.status(400).json({ error: 'invalid operation data' });
    }
    // Broadcast the operation update to all connected websocket clients
    broadcastOperation(operation);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling operation update:', error);
    res.status(500).json({ error: 'failed to process operation update' });
  }
});

// Crypto prices endpoint with caching
app.get('/api/crypto-prices', async (req, res) => {
  try {
    if (isCacheValid()) {
      logger.debug('Returning cached crypto prices');
      return res.json(cryptoPriceCache.data);
    }

    logger.debug('Fetching crypto prices from CoinGecko');
    const prices = await fetchCryptoPricesFromAPI();
    cryptoPriceCache.data = prices;
    cryptoPriceCache.timestamp = Date.now();
    res.json(prices);
  } catch (error) {
    logger.error('Failed to fetch crypto prices:', error);
    // Return cached data if available, even if expired
    if (cryptoPriceCache.data) {
      logger.debug('Returning stale cached data due to API error');
      return res.json(cryptoPriceCache.data);
    }
    // Return null values instead of 500 error to prevent UI breakage
    logger.debug('No cached data available, returning null values');
    res.json({
      bitcoin: null,
      ethereum: null,
    });
  }
});

// SPA fallback - serve index.html for all non-API, non-asset routes
// This must be placed AFTER all API routes so they are matched first
// Rate limited to prevent abuse
app.get('*', fileServerLimiter, (req, res) => {
  // Skip if this is an API route or asset request (shouldn't reach here, but safety check)
  if (req.path.startsWith('/api') || req.path.startsWith('/assets')) {
    return res.status(404).json({ error: 'not found' });
  }
  // Serve index.html for SPA routing
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Validate configuration
try {
  // Config validation happens during import
  if (!WEBUI_PORT || !MAIN_SERVER_URL) {
    throw new ConfigurationError('Required WebUI configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Create HTTP server from Express app
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/api/ws' });

// Store connected clients
const clients = new Set();

// Store operation in memory
function storeOperation(operation) {
  const index = operations.findIndex(op => op.id === operation.id);
  if (index !== -1) {
    // Update existing operation
    operations[index] = operation;
  } else {
    // Add new operation at the beginning
    operations.unshift(operation);
    // Keep only last 100 operations
    if (operations.length > MAX_OPERATIONS) {
      operations.pop();
    }
  }
}

// Broadcast function to send updates to all connected clients
function broadcastOperation(operation) {
  // Store the operation
  storeOperation(operation);

  // Broadcast to all connected clients
  const message = JSON.stringify({ type: 'operation', data: operation });
  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending websocket message:', error);
      }
    }
  });
}

// Set the broadcast callback in operations tracker
setBroadcastCallback(broadcastOperation);

// Handle WebSocket connections
wss.on('connection', ws => {
  logger.debug('WebSocket client connected');
  clients.add(ws);

  // Send initial operations list to newly connected client
  try {
    ws.send(JSON.stringify({ type: 'operations', data: [...operations] }));
  } catch (error) {
    logger.error('Error sending initial operations:', error);
  }

  // Handle client disconnect
  ws.on('close', () => {
    logger.debug('WebSocket client disconnected');
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', error => {
    logger.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Start server
server.listen(WEBUI_PORT, WEBUI_HOST, () => {
  logger.info(`webui server running on http://${WEBUI_HOST}:${WEBUI_PORT}`);
  logger.info(`dashboard: http://${WEBUI_HOST}:${WEBUI_PORT}`);
  logger.info(`websocket: ws://${WEBUI_HOST}:${WEBUI_PORT}/api/ws`);
  logger.info(`main server: ${MAIN_SERVER_URL}`);
});

// Handle errors
app.on('error', error => {
  logger.error('WebUI error:', error);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  // Close WebSocket server
  wss.close(() => {
    logger.info('WebSocket server closed');
  });
  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  // Close WebSocket server
  wss.close(() => {
    logger.info('WebSocket server closed');
  });
  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});
