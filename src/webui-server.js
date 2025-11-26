import express from 'express';
import path from 'path';
import axios from 'axios';
import http from 'http';
import { WebSocketServer } from 'ws';
import rateLimit from 'express-rate-limit';
import { createLogger, setLogBroadcastCallback } from './utils/logger.js';
import { webuiConfig } from './utils/config.js';
import { ConfigurationError } from './utils/errors.js';
import {
  setBroadcastCallback,
  setUserMetricsBroadcastCallback,
} from './utils/operations-tracker.js';
import { setBroadcastCallback as setAlertBroadcastCallback } from './utils/ntfy-notifier.js';
import {
  initDatabase,
  getLogs,
  getLogsCount,
  getLogComponents,
  getLogMetrics,
  getAllUsersMetrics,
  getUserMetricsCount,
  getUserMetrics,
  getUser,
  getOperationTrace,
  getSystemMetrics,
  getLatestSystemMetrics,
  getAlerts,
  getAlertsCount,
  getUserMedia,
  getUserMediaCount,
  getRecentOperations,
  searchOperationsByUrl,
  getFailedOperationsByUser,
} from './utils/database.js';
import {
  collectSystemMetrics,
  startMetricsCollection,
  stopMetricsCollection,
  setBroadcastCallback as setSystemMetricsBroadcastCallback,
} from './utils/system-metrics.js';

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

// Stats cache to reduce load on main server
const STATS_CACHE_TTL = 30 * 1000; // 30 seconds - match Monitoring page refresh interval
let statsCache = null;
let statsCacheTimestamp = 0;
// Health cache to reduce load on main server
const HEALTH_CACHE_TTL = 30 * 1000; // 30 seconds - match stats cache TTL
let healthCache = null;
let healthCacheTimestamp = 0;
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
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Proxy endpoint to fetch stats from main server
app.get('/api/stats', async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    if (statsCache && now - statsCacheTimestamp < STATS_CACHE_TTL) {
      logger.debug('Returning cached stats');
      return res.json(statsCache);
    }

    logger.debug('Fetching stats from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/api/stats`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });

    // Cache the response
    statsCache = response.data;
    statsCacheTimestamp = now;

    res.json(response.data);
  } catch (error) {
    // If we have cached data and the request failed, return cached data
    if (statsCache && error.response?.status === 429) {
      logger.warn('Rate limited by main server, returning cached stats');
      return res.json(statsCache);
    }

    logger.error('Failed to fetch stats from main server:', error);

    // If we have stale cache, return it anyway as fallback
    if (statsCache) {
      logger.warn('Returning stale cached stats due to error');
      return res.json(statsCache);
    }

    res.status(500).json({
      error: 'failed to fetch stats',
      message: error.message,
    });
  }
});

// Proxy endpoint to fetch health from main server
app.get('/api/health', async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    if (healthCache && now - healthCacheTimestamp < HEALTH_CACHE_TTL) {
      logger.debug('Returning cached health');
      return res.json(healthCache);
    }

    logger.debug('Fetching health from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/health`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });

    // Cache the response
    healthCache = response.data;
    healthCacheTimestamp = now;

    res.json(response.data);
  } catch (error) {
    // If we have cached data and the request failed, return cached data
    if (healthCache && error.response?.status === 429) {
      logger.warn('Rate limited by main server, returning cached health');
      return res.json(healthCache);
    }

    logger.error('Failed to fetch health from main server:', error);

    // If we have stale cache, return it anyway as fallback
    if (healthCache) {
      logger.warn('Returning stale cached health due to error');
      return res.json(healthCache);
    }

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

// Endpoint for bot to send user metrics updates
app.post('/api/user-metrics', express.json(), (req, res) => {
  try {
    const { userId, metrics } = req.body;
    if (!userId || !metrics) {
      return res.status(400).json({ error: 'invalid user metrics data' });
    }
    // Broadcast the user metrics update to all connected websocket clients
    broadcastUserMetrics(userId, metrics);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling user metrics update:', error);
    res.status(500).json({ error: 'failed to process user metrics update' });
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

// Logs endpoint with filtering and pagination
app.get('/api/logs', (req, res) => {
  try {
    const {
      component,
      level,
      startTime,
      endTime,
      search,
      limit = 100,
      offset = 0,
      orderDesc = 'true',
      excludedComponents,
    } = req.query;

    // Parse query parameters
    const options = {
      orderDesc: orderDesc === 'true',
      limit: parseInt(limit, 10) || 100,
      offset: parseInt(offset, 10) || 0,
    };

    if (component) options.component = component;
    if (search) options.search = search;
    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    // Handle multiple levels (comma-separated)
    if (level) {
      if (Array.isArray(level)) {
        // Multiple level parameters: flatten and trim all values
        options.level = level.flatMap(l =>
          typeof l === 'string' ? l.split(',').map(sub => sub.trim()) : []
        );
      } else if (typeof level === 'string') {
        if (level.includes(',')) {
          options.level = level.split(',').map(l => l.trim());
        } else {
          options.level = level.trim();
        }
      } else {
        // Unexpected type, ignore or reject (here we ignore)
      }
    }

    // Handle excluded components (comma-separated)
    if (excludedComponents) {
      if (Array.isArray(excludedComponents)) {
        // Multiple excluded component parameters: flatten and trim all values
        options.excludedComponents = excludedComponents.flatMap(c =>
          typeof c === 'string' ? c.split(',').map(sub => sub.trim()) : []
        );
      } else if (typeof excludedComponents === 'string') {
        if (excludedComponents.includes(',')) {
          options.excludedComponents = excludedComponents.split(',').map(c => c.trim());
        } else {
          options.excludedComponents = [excludedComponents.trim()];
        }
      }
    }

    // Always exclude webui INFO logs from the logs list (to mute HTTP request noise)
    // But keep ERROR/WARN logs from webui visible
    options.excludeComponentLevels = [{ component: 'webui', level: 'INFO' }];

    // Get logs and total count
    const logs = getLogs(options);
    const total = getLogsCount(options);

    res.json({
      logs,
      total,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch logs:', error);
    res.status(500).json({
      error: 'failed to fetch logs',
      message: error.message,
    });
  }
});

// Log metrics endpoint
app.get('/api/logs/metrics', (req, res) => {
  try {
    const { timeRange } = req.query;
    const options = {};

    if (timeRange) {
      options.timeRange = parseInt(timeRange, 10);
    }

    const metrics = getLogMetrics(options);
    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch log metrics:', error);
    res.status(500).json({
      error: 'failed to fetch log metrics',
      message: error.message,
    });
  }
});

// Log components endpoint
app.get('/api/logs/components', (req, res) => {
  try {
    const components = getLogComponents();
    res.json({ components });
  } catch (error) {
    logger.error('Failed to fetch log components:', error);
    res.status(500).json({
      error: 'failed to fetch log components',
      message: error.message,
    });
  }
});

// Users list endpoint
app.get('/api/users', (req, res) => {
  try {
    const {
      search,
      sortBy = 'total_commands',
      sortDesc = 'true',
      limit = 50,
      offset = 0,
    } = req.query;

    const options = {
      search,
      sortBy,
      sortDesc: sortDesc === 'true',
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    };

    const users = getAllUsersMetrics(options);
    const total = getUserMetricsCount({ search });

    res.json({
      users,
      total,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch users:', error);
    res.status(500).json({
      error: 'failed to fetch users',
      message: error.message,
    });
  }
});

// User profile endpoint
app.get('/api/users/:userId', (req, res) => {
  try {
    const { userId } = req.params;

    const userMetrics = getUserMetrics(userId);
    const userInfo = getUser(userId);

    if (!userMetrics && !userInfo) {
      return res.status(404).json({ error: 'user not found' });
    }

    res.json({
      user: userInfo,
      metrics: userMetrics,
    });
  } catch (error) {
    logger.error('Failed to fetch user profile:', error);
    res.status(500).json({
      error: 'failed to fetch user profile',
      message: error.message,
    });
  }
});

// User operations endpoint (from recent operations in memory and database)
app.get('/api/users/:userId/operations', (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);

    // Filter operations by user from in-memory store
    let userOps = operations.filter(op => op.userId === userId);

    // Get operations from database to ensure we have all of them for counting
    try {
      // Get a large number of operations from database to account for filtering
      const dbOps = getRecentOperations(1000) // Get enough to account for filtering
        .filter(op => op.userId === userId);

      // Merge with in-memory operations, avoiding duplicates
      const existingIds = new Set(userOps.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      userOps = [...userOps, ...newOps].sort((a, b) => b.timestamp - a.timestamp); // Sort by most recent
    } catch (error) {
      logger.error('Failed to fetch user operations from database:', error);
      // Continue with in-memory operations only
      userOps = userOps.sort((a, b) => b.timestamp - a.timestamp);
    }

    // Get total count before applying pagination
    const total = userOps.length;

    // Apply pagination (offset and limit)
    const paginatedOps = userOps.slice(offsetNum, offsetNum + limitNum);

    res.json({
      operations: paginatedOps,
      total: total,
    });
  } catch (error) {
    logger.error('Failed to fetch user operations:', error);
    res.status(500).json({
      error: 'failed to fetch user operations',
      message: error.message,
    });
  }
});

// User activity timeline (from logs)
app.get('/api/users/:userId/activity', (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    // Get logs related to this user, only from bot component (user actions)
    const logs = getLogs({
      search: userId,
      component: 'bot', // Only show bot component logs (user commands and actions)
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      orderDesc: true,
    });

    const total = getLogsCount({
      search: userId,
      component: 'bot', // Only count bot component logs
    });

    res.json({
      activity: logs,
      total,
    });
  } catch (error) {
    logger.error('Failed to fetch user activity:', error);
    res.status(500).json({
      error: 'failed to fetch user activity',
      message: error.message,
    });
  }
});

// User media endpoint (from processed_urls)
app.get('/api/users/:userId/media', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 25, offset = 0 } = req.query;

    logger.debug(`Fetching media for user ${userId} (limit: ${limit}, offset: ${offset})`);

    // Get media files for this user
    const media = await getUserMedia(userId, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    const total = await getUserMediaCount(userId);

    logger.debug(`Found ${media.length} media items (total: ${total}) for user ${userId}`);

    res.json({
      media,
      total,
    });
  } catch (error) {
    logger.error(`Failed to fetch user media for user ${req.params.userId}:`, error);
    res.status(500).json({
      error: 'failed to fetch user media',
      message: error.message,
    });
  }
});

/**
 * Reconstruct operation object from database trace
 * @param {Object} trace - Operation trace from database
 * @returns {Object|null} Reconstructed operation object or null
 */
function reconstructOperationFromTrace(trace) {
  if (!trace || !trace.logs || trace.logs.length === 0) {
    return null;
  }

  const createdLog = trace.logs.find(log => log.step === 'created');
  if (!createdLog) {
    return null;
  }

  const context = trace.context || {};
  const parsedLogs = trace.logs;

  // Find the latest status update
  const statusUpdateLogs = parsedLogs.filter(log => log.step === 'status_update');
  const latestStatusLog =
    statusUpdateLogs.length > 0 ? statusUpdateLogs[statusUpdateLogs.length - 1] : createdLog;

  // Extract fileSize, error, stackTrace from status update logs and error logs
  let fileSize = null;
  let error = null;
  let stackTrace = null;

  // Check error logs first (they have the most complete error info)
  const errorLogs = parsedLogs.filter(log => log.step === 'error');
  if (errorLogs.length > 0) {
    const latestErrorLog = errorLogs[errorLogs.length - 1];
    if (latestErrorLog.message && error === null) {
      error = latestErrorLog.message;
    }
    if (latestErrorLog.stack_trace && stackTrace === null) {
      stackTrace = latestErrorLog.stack_trace;
    }
  }

  // Look through status updates for these fields (newest first)
  for (const log of statusUpdateLogs.reverse()) {
    if (log.metadata) {
      if (log.metadata.fileSize !== undefined && fileSize === null) {
        fileSize = log.metadata.fileSize;
      }
      if (log.metadata.error !== undefined && error === null) {
        error = log.metadata.error;
      }
      if (log.metadata.stackTrace !== undefined && stackTrace === null) {
        stackTrace = log.metadata.stackTrace;
      }
    }
    // Also check direct fields
    if (log.stack_trace && stackTrace === null) {
      stackTrace = log.stack_trace;
    }
  }

  // Build filePaths array from all logs that have file_path
  const filePaths = [];
  parsedLogs.forEach(log => {
    if (log.file_path && !filePaths.includes(log.file_path)) {
      filePaths.push(log.file_path);
    }
  });

  // Build performance metrics steps
  const steps = parsedLogs
    .filter(log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error')
    .map(log => {
      let stepStatus = log.status;

      // If operation is complete and step is still 'running', infer completion status
      const finalStatus = latestStatusLog.status;
      if ((finalStatus === 'success' || finalStatus === 'error') && stepStatus === 'running') {
        // If operation succeeded, running steps should be marked as success
        // If operation failed, running steps should be marked as error
        stepStatus = finalStatus === 'success' ? 'success' : 'error';
      }

      return {
        step: log.step,
        status: stepStatus,
        timestamp: log.timestamp,
        duration: log.timestamp - createdLog.timestamp,
        ...(log.metadata || {}),
      };
    });

  // Calculate duration if operation is complete
  let duration = null;
  const finalStatus = latestStatusLog.status;
  if ((finalStatus === 'success' || finalStatus === 'error') && createdLog.timestamp) {
    const endTimestamp = latestStatusLog.timestamp;
    duration = endTimestamp - createdLog.timestamp;
  }

  // Get most recent timestamp
  const latestTimestamp = Math.max(...parsedLogs.map(log => log.timestamp));

  // Determine operation type with fallback logic
  let operationType = context.operationType;
  if (!operationType || operationType === 'unknown') {
    // Infer operation type from step names
    const stepNames = parsedLogs
      .map(log => log.step)
      .join(' ')
      .toLowerCase();
    if (
      stepNames.includes('conversion') ||
      stepNames.includes('gif') ||
      stepNames.includes('convert')
    ) {
      operationType = 'convert';
    } else if (stepNames.includes('optimization') || stepNames.includes('optimize')) {
      operationType = 'optimize';
    } else if (stepNames.includes('download') && !stepNames.includes('conversion')) {
      operationType = 'download';
    } else {
      operationType = 'unknown';
      // Log when we can't determine operation type
      logger.debug(
        `Could not determine operation type for ${trace.operationId}, step names: ${stepNames}`
      );
    }
  }

  // Determine username with fallback logic
  let username = context.username;
  // Always try to enrich username from users table if we have a userId
  // This handles cases where metadata was null or username wasn't stored
  if (context.userId) {
    // If username is missing or unknown, try to get it from users table
    if (!username || username === 'unknown') {
      try {
        const user = getUser(context.userId);
        if (user && user.username) {
          username = user.username;
        } else {
          logger.debug(
            `User not found for userId ${context.userId} in operation ${trace.operationId}`
          );
        }
      } catch (error) {
        logger.debug(
          `Failed to lookup user ${context.userId} for operation ${trace.operationId}: ${error.message}`
        );
      }
    }
  } else {
    logger.debug(`No userId found for operation ${trace.operationId} (metadata may be null)`);
  }
  // If still no username after all attempts, use null (will display as 'unknown' in UI)
  if (!username || username === 'unknown') {
    username = null;
  }

  // Reconstruct operation object
  return {
    id: trace.operationId,
    type: operationType,
    status: latestStatusLog.status || 'pending',
    userId: context.userId || null,
    username: username,
    fileSize: fileSize,
    timestamp: latestTimestamp,
    startTime: createdLog.timestamp,
    error: error,
    stackTrace: stackTrace,
    filePaths: filePaths,
    performanceMetrics: {
      duration: duration,
      steps: steps,
    },
  };
}

// Operations search endpoint - MUST come before /api/operations/:operationId
// Otherwise Express will match "search" as an operationId parameter
app.get('/api/operations/search', (req, res) => {
  try {
    const {
      operationId,
      status,
      type,
      userId,
      username,
      urlPattern,
      dateFrom,
      dateTo,
      minDuration,
      maxDuration,
      minFileSize,
      maxFileSize,
      failedOnly,
      limit = 100,
      offset = 0,
    } = req.query;

    // Start with WebSocket operations (real-time)
    let allOperations = [...operations];

    // Get operations from database (historical)
    try {
      const dbLimit = parseInt(limit, 10) + parseInt(offset, 10) + 100; // Get extra for filtering
      const dbOps = getRecentOperations(dbLimit);
      
      // Merge with in-memory operations, avoiding duplicates
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
      // Continue with in-memory operations only
    }

    // Apply filters
    let filtered = allOperations;

    // Operation ID search (exact match)
    if (operationId) {
      filtered = filtered.filter(op => op.id === operationId);
    }

    // Status filter
    if (status) {
      const statusArray = Array.isArray(status) ? status : [status];
      filtered = filtered.filter(op => statusArray.includes(op.status));
    }

    // Type filter
    if (type) {
      const typeArray = Array.isArray(type) ? type : [type];
      filtered = filtered.filter(op => typeArray.includes(op.type));
    }

    // User ID filter
    if (userId) {
      filtered = filtered.filter(op => op.userId === userId);
    }

    // Username filter
    if (username) {
      const usernameLower = username.toLowerCase();
      filtered = filtered.filter(
        op => op.username && op.username.toLowerCase().includes(usernameLower)
      );
    }

    // URL pattern search (requires getting traces from database)
    if (urlPattern) {
      try {
        const urlTraces = searchOperationsByUrl(urlPattern, 1000);
        const urlOperationIds = new Set(urlTraces.map(trace => trace.operationId));
        filtered = filtered.filter(op => urlOperationIds.has(op.id));
      } catch (error) {
        logger.error('Failed to search operations by URL:', error);
        // Continue without URL filter if search fails
      }
    }

    // Failed only filter
    if (failedOnly === 'true') {
      filtered = filtered.filter(op => op.status === 'error');
    }

    // Date range filter
    if (dateFrom) {
      const fromTimestamp = parseInt(dateFrom, 10);
      filtered = filtered.filter(op => op.timestamp >= fromTimestamp);
    }
    if (dateTo) {
      const toTimestamp = parseInt(dateTo, 10);
      filtered = filtered.filter(op => op.timestamp <= toTimestamp);
    }

    // Duration filter
    if (minDuration) {
      const minDur = parseInt(minDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration >= minDur
      );
    }
    if (maxDuration) {
      const maxDur = parseInt(maxDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration <= maxDur
      );
    }

    // File size filter
    if (minFileSize) {
      const minSize = parseInt(minFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize >= minSize);
    }
    if (maxFileSize) {
      const maxSize = parseInt(maxFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize <= maxSize);
    }

    // Sort by timestamp (most recent first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginated = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({
      operations: paginated,
      total: filtered.length,
    });
  } catch (error) {
    logger.error('Failed to search operations:', error);
    res.status(500).json({
      error: 'failed to search operations',
      message: error.message,
    });
  }
});

// Operation details endpoint - MUST come after /api/operations/search
app.get('/api/operations/:operationId', (req, res) => {
  try {
    const { operationId } = req.params;

    // Get operation from in-memory store
    let operation = operations.find(op => op.id === operationId);

    // If not in memory, try to reconstruct from database
    if (!operation) {
      const trace = getOperationTrace(operationId);
      if (trace) {
        operation = reconstructOperationFromTrace(trace);
      }
    }

    // Get detailed trace from database with parsed metadata
    const trace = getOperationTrace(operationId);

    // Debug logging
    if (trace) {
      const executionStepsCount = trace.logs.filter(
        log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error'
      ).length;
      logger.debug(`Trace retrieved for operation ${operationId}: ${trace.logs.length} total logs, ${executionStepsCount} execution steps`);
    } else {
      logger.debug(`No trace found for operation ${operationId}`);
    }

    if (!operation && !trace) {
      return res.status(404).json({ error: 'operation not found' });
    }

    res.json({
      operation: operation || null,
      trace: trace || null,
    });
  } catch (error) {
    logger.error('Failed to fetch operation details:', error);
    res.status(500).json({
      error: 'failed to fetch operation details',
      message: error.message,
    });
  }
});

// Operation trace endpoint
app.get('/api/operations/:operationId/trace', (req, res) => {
  try {
    const { operationId } = req.params;
    const trace = getOperationTrace(operationId);

    if (!trace) {
      return res.status(404).json({ error: 'operation trace not found' });
    }

    res.json({ trace });
  } catch (error) {
    logger.error('Failed to fetch operation trace:', error);
    res.status(500).json({
      error: 'failed to fetch operation trace',
      message: error.message,
    });
  }
});

// Related operations endpoint
app.get('/api/operations/:operationId/related', (req, res) => {
  try {
    const { operationId } = req.params;
    const trace = getOperationTrace(operationId);

    if (!trace) {
      return res.status(404).json({ error: 'operation not found' });
    }

    const context = trace.context || {};
    const userId = context.userId;
    const originalUrl = context.originalUrl;

    // Get all operations
    let allOperations = [...operations];
    try {
      const dbOps = getRecentOperations(1000);
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
    }

    // Find related operations (same user or same URL)
    const related = [];
    const seenIds = new Set([operationId]);
    
    for (const op of allOperations) {
      if (seenIds.has(op.id)) continue;
      
      let isRelated = false;
      
      // Match by user ID
      if (userId && op.userId === userId) {
        isRelated = true;
      }
      
      // Match by URL - get trace to check originalUrl
      if (originalUrl && !isRelated) {
        try {
          const opTrace = getOperationTrace(op.id);
          if (opTrace && opTrace.context && opTrace.context.originalUrl === originalUrl) {
            isRelated = true;
          }
        } catch (error) {
          // Skip if trace lookup fails
        }
      }
      
      if (isRelated) {
        related.push(op);
        seenIds.add(op.id);
        if (related.length >= 10) break; // Limit to 10
      }
    }

    // Sort by timestamp
    related.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ operations: related });
  } catch (error) {
    logger.error('Failed to fetch related operations:', error);
    res.status(500).json({
      error: 'failed to fetch related operations',
      message: error.message,
    });
  }
});

// Error analysis endpoint
app.get('/api/operations/errors/analysis', (req, res) => {
  try {
    // Get all operations with errors
    let allOperations = [...operations];
    try {
      const dbOps = getRecentOperations(1000);
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
    }

    // Filter to only error operations
    const errorOps = allOperations.filter(op => op.status === 'error' && op.error);

    // Group by error message pattern (normalize for grouping)
    const errorGroups = new Map();
    
    errorOps.forEach(op => {
      const errorMsg = op.error || 'unknown error';
      // Normalize error message for grouping (remove specific details like IDs, timestamps)
      const normalized = errorMsg
        .replace(/\d+/g, 'N')
        .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, 'UUID')
        .substring(0, 200); // Limit length
      
      if (!errorGroups.has(normalized)) {
        errorGroups.set(normalized, {
          pattern: errorMsg.substring(0, 150), // Use first 150 chars of original as pattern
          count: 0,
        });
      }
      errorGroups.get(normalized).count++;
    });

    // Convert to array and sort by count
    const groups = Array.from(errorGroups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // Top 20 error patterns

    res.json({ groups });
  } catch (error) {
    logger.error('Failed to analyze errors:', error);
    res.status(500).json({
      error: 'failed to analyze errors',
      message: error.message,
    });
  }
});

// Error metrics endpoint
app.get('/api/metrics/errors', (req, res) => {
  try {
    const { timeRange } = req.query;
    const options = {
      // Don't exclude webui from error/warning counts - we want to see those!
      // Only exclude webui INFO logs from totals/aggregations to reduce noise
      excludedComponents: null,
    };

    if (timeRange) {
      options.timeRange = parseInt(timeRange, 10);
    }

    const metrics = getLogMetrics(options);

    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch error metrics:', error);
    res.status(500).json({
      error: 'failed to fetch error metrics',
      message: error.message,
    });
  }
});

// System metrics endpoint
app.get('/api/metrics/system', async (req, res) => {
  try {
    const { limit = 100, startTime, endTime } = req.query;

    const options = {
      limit: parseInt(limit, 10),
    };

    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    const metrics = getSystemMetrics(options);

    // Also get current metrics
    const current = await collectSystemMetrics();

    res.json({
      current,
      history: metrics,
    });
  } catch (error) {
    logger.error('Failed to fetch system metrics:', error);
    res.status(500).json({
      error: 'failed to fetch system metrics',
      message: error.message,
    });
  }
});

// System metrics current endpoint
app.get('/api/metrics/system/current', async (req, res) => {
  try {
    const metrics = await collectSystemMetrics();

    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch current system metrics:', error);
    res.status(500).json({
      error: 'failed to fetch current system metrics',
      message: error.message,
    });
  }
});

// Alerts endpoint
app.get('/api/alerts', (req, res) => {
  try {
    const { severity, component, startTime, endTime, search, limit = 100, offset = 0 } = req.query;

    const options = {
      severity,
      component,
      search,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    };

    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    const alerts = getAlerts(options);
    const total = getAlertsCount(options);

    res.json({
      alerts,
      total,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch alerts:', error);
    res.status(500).json({
      error: 'failed to fetch alerts',
      message: error.message,
    });
  }
});

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

// Ping/pong heartbeat configuration
const PING_INTERVAL = 30000; // 30 seconds
// PONG_TIMEOUT removed - not currently used
let pingInterval = null;

// Helper function to enrich operation with username from database
function enrichOperationUsername(operation) {
  // Always try to enrich if we have a userId, even if username is already set
  // This ensures we get the latest username from the database
  if (operation.userId) {
    // Only enrich if username is missing or unknown
    if (!operation.username || operation.username === 'unknown') {
      try {
        const user = getUser(operation.userId);
        if (user && user.username) {
          operation.username = user.username;
          return true; // Username was enriched
        } else {
          // User not found in database - this is expected for some operations
          // The username will remain as null/unknown
        }
      } catch (error) {
        // Silently fail - operation will keep original username
        logger.debug(`Failed to enrich username for operation ${operation.id}: ${error.message}`);
      }
    }
  }
  return false; // Username was not enriched
}

// Store operation in memory
function storeOperation(operation) {
  // Enrich operation with username if missing
  enrichOperationUsername(operation);

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

// Broadcast function to send log updates to all connected clients
export function broadcastLog(logEntry) {
  const message = JSON.stringify({ type: 'log', data: logEntry });
  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending log websocket message:', error);
      }
    }
  });
}

// Broadcast function to send system metrics updates
export function broadcastSystemMetrics(metrics) {
  const message = JSON.stringify({ type: 'system_metrics', data: metrics });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending system metrics websocket message:', error);
      }
    }
  });
}

// Broadcast function to send alert notifications
export function broadcastAlert(alert) {
  const message = JSON.stringify({ type: 'alert', data: alert });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending alert websocket message:', error);
      }
    }
  });
}

// Broadcast function to send user metrics updates
export function broadcastUserMetrics(userId, metrics) {
  const message = JSON.stringify({ type: 'user_metrics', data: { userId, metrics } });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending user metrics websocket message:', error);
      }
    }
  });
}

// Set the broadcast callback in operations tracker (with instance port)
setBroadcastCallback(broadcastOperation, WEBUI_PORT);

// Set the log broadcast callback
setLogBroadcastCallback(broadcastLog);

// Set the system metrics broadcast callback
setSystemMetricsBroadcastCallback(broadcastSystemMetrics);

// Set the alert broadcast callback
setAlertBroadcastCallback(broadcastAlert);

// Set the user metrics broadcast callback (with instance port)
setUserMetricsBroadcastCallback(broadcastUserMetrics, WEBUI_PORT);

// Clean up dead connections
function cleanupDeadConnections() {
  const deadClients = [];
  clients.forEach(client => {
    if (client.readyState !== 1) {
      // WebSocket.OPEN = 1, any other state means disconnected
      deadClients.push(client);
    }
  });

  deadClients.forEach(client => {
    logger.debug('Removing dead WebSocket connection');
    clients.delete(client);
    try {
      client.terminate();
    } catch (_err) {
      // Ignore errors when terminating
    }
  });

  if (deadClients.length > 0) {
    logger.debug(`Cleaned up ${deadClients.length} dead WebSocket connection(s)`);
  }
}

// Send ping to all connected clients and remove those that don't respond
function pingClients() {
  const clientsToRemove = [];

  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      // Check if client is still alive (isAlive flag set by pong handler)
      if (client.isAlive === false) {
        // Client didn't respond to previous ping
        logger.debug('WebSocket client did not respond to ping, removing');
        clientsToRemove.push(client);
        return;
      }

      // Mark as not alive, will be set to true when pong is received
      client.isAlive = false;

      try {
        // Send ping frame
        client.ping();
      } catch (err) {
        logger.error('Error sending ping to WebSocket client:', err);
        clientsToRemove.push(client);
      }
    } else {
      // Not open, mark for removal
      clientsToRemove.push(client);
    }
  });

  // Remove dead clients
  clientsToRemove.forEach(client => {
    clients.delete(client);
    try {
      client.terminate();
    } catch (_err) {
      // Ignore errors when terminating
    }
  });

  // Also clean up any other dead connections
  cleanupDeadConnections();
}

// Handle WebSocket connections
wss.on('connection', async ws => {
  logger.debug('WebSocket client connected');
  clients.add(ws);

  // Mark client as alive initially
  ws.isAlive = true;

  // Handle pong response - mark client as alive
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Send initial data to newly connected client
  try {
    // Enrich any operations that might have missing usernames before sending
    const enrichedOps = operations.map(op => {
      const enriched = { ...op };
      enrichOperationUsername(enriched);
      return enriched;
    });
    // Send initial operations list
    ws.send(JSON.stringify({ type: 'operations', data: enrichedOps }));

    // Send latest system metrics
    try {
      const latestMetrics = await getLatestSystemMetrics();
      if (latestMetrics) {
        ws.send(JSON.stringify({ type: 'system_metrics', data: latestMetrics }));
      }
    } catch (error) {
      logger.error('Error sending initial system metrics:', error);
    }

    // Send recent alerts (last 10)
    try {
      const recentAlerts = getAlerts({ limit: 10, offset: 0 });
      if (recentAlerts && recentAlerts.length > 0) {
        recentAlerts.forEach(alert => {
          ws.send(JSON.stringify({ type: 'alert', data: alert }));
        });
      }
    } catch (error) {
      logger.error('Error sending initial alerts:', error);
    }
  } catch (error) {
    logger.error('Error sending initial data:', error);
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

// Initialize database and start server
(async () => {
  try {
    await initDatabase();
    logger.info('database initialized');

    // Load recent operations from database
    try {
      const recentOps = getRecentOperations(MAX_OPERATIONS);
      if (recentOps.length > 0) {
        // Enrich operations with usernames if missing
        let enrichedCount = 0;
        recentOps.forEach(op => {
          if (enrichOperationUsername(op)) {
            enrichedCount++;
          }
        });
        // Add operations to in-memory store (most recent first)
        operations.push(...recentOps);
        logger.info(
          `loaded ${recentOps.length} operations from database${enrichedCount > 0 ? `, enriched ${enrichedCount} usernames` : ''}`
        );
      }
    } catch (error) {
      logger.error('failed to load operations from database:', error);
      // Continue startup even if loading operations fails
    }
  } catch (error) {
    logger.error('failed to initialize database:', error);
    process.exit(1);
  }

  // Start server
  server.listen(WEBUI_PORT, WEBUI_HOST, () => {
    logger.info(`webui server running on http://${WEBUI_HOST}:${WEBUI_PORT}`);
    logger.info(`dashboard: http://${WEBUI_HOST}:${WEBUI_PORT}`);
    logger.info(`websocket: ws://${WEBUI_HOST}:${WEBUI_PORT}/api/ws`);
    logger.info(`main server: ${MAIN_SERVER_URL}`);

    // Start system metrics collection (every 60 seconds)
    startMetricsCollection(60000);
    logger.info('started system metrics collection');

    // Start ping/pong heartbeat (every 30 seconds)
    pingInterval = setInterval(() => {
      pingClients();
    }, PING_INTERVAL);
    logger.info('started WebSocket ping/pong heartbeat');
  });
})();

// Handle errors
app.on('error', error => {
  logger.error('WebUI error:', error);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  // Stop metrics collection
  stopMetricsCollection();
  // Stop ping interval
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
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
  // Stop metrics collection
  stopMetricsCollection();
  // Stop ping interval
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
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
