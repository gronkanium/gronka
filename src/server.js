import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import rateLimit from 'express-rate-limit';
import { getStorageStats } from './utils/storage.js';
import { createLogger, formatTimestampSeconds } from './utils/logger.js';
import { serverConfig } from './utils/config.js';
import { validateFilename } from './utils/validation.js';
import { ConfigurationError } from './utils/errors.js';

const execAsync = promisify(exec);

// Initialize logger
const logger = createLogger('server');

// Configuration from centralized config
const {
  gifStoragePath: GIF_STORAGE_PATH,
  serverPort: SERVER_PORT,
  serverHost: HOST,
  statsUsername: STATS_USERNAME,
  statsPassword: STATS_PASSWORD,
  corsOrigin: CORS_ORIGIN,
} = serverConfig;

const app = express();

// Trust proxy for proper IP detection in Docker network and Cloudflare tunnel
// Set to 1 to trust one proxy (Cloudflare tunnel)
// This prevents the express-rate-limit security warning while still allowing proper IP detection
app.set('trust proxy', 1);

// Configure body parser with size limits (defensive measure)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security headers middleware
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Rate limiting configurations
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per windowMs
  message: 'too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    // Skip rate limiting only for requests from internal Docker network (webui container)
    // Use req.ip which is properly handled by express 'trust proxy' setting
    // Do NOT trust X-Forwarded-For directly as it can be spoofed by attackers
    const ip = req.ip || '';
    const ipStr = String(ip);

    // Only allow skip for known Docker network IPs (private ranges used by Docker)
    // This includes: 172.16.0.0/12, 192.168.0.0/16, 10.0.0.0/8
    // REMOVED: Authorization header check - it was insecure as anyone could send auth header to bypass rate limits
    if (
      ipStr.startsWith('172.') ||
      ipStr.startsWith('192.168.') ||
      ipStr.startsWith('10.') ||
      ipStr.includes('::ffff:172.') ||
      ipStr.includes('::ffff:192.168.') ||
      ipStr.includes('::ffff:10.')
    ) {
      return true;
    }

    return false;
  },
});

const cdnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Higher limit for CDN endpoints (main purpose)
  message: 'too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const statsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Very strict limit for sensitive stats endpoint
  message: 'too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    // Skip rate limiting only for requests from internal Docker network (webui container)
    // Use req.ip which is properly handled by express 'trust proxy' setting
    // Do NOT trust X-Forwarded-For directly as it can be spoofed by attackers
    const ip = req.ip || '';
    const ipStr = String(ip);

    // Only allow skip for known Docker network IPs (private ranges used by Docker)
    // This includes: 172.16.0.0/12, 192.168.0.0/16, 10.0.0.0/8
    // REMOVED: Authorization header check - it was insecure as anyone could send auth header to bypass rate limits
    if (
      ipStr.startsWith('172.') ||
      ipStr.startsWith('192.168.') ||
      ipStr.startsWith('10.') ||
      ipStr.includes('::ffff:172.') ||
      ipStr.includes('::ffff:192.168.') ||
      ipStr.includes('::ffff:10.')
    ) {
      return true;
    }

    return false;
  },
});

// Apply general rate limiting to all requests
app.use(generalLimiter);

// Request logging middleware
app.use((req, res, next) => {
  // Skip logging for health check requests
  if (req.path === '/health') {
    return next();
  }

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

// Get absolute path to GIF storage
function getStoragePath() {
  if (path.isAbsolute(GIF_STORAGE_PATH)) {
    return GIF_STORAGE_PATH;
  }
  return path.resolve(process.cwd(), GIF_STORAGE_PATH);
}

const storagePath = getStoragePath();

/**
 * Basic authentication middleware for sensitive endpoints
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function basicAuth(req, res, next) {
  if (!STATS_USERNAME || !STATS_PASSWORD) {
    // No auth configured, allow access
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Stats API"');
    return res.status(401).json({ error: 'authentication required' });
  }

  const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  if (username === STATS_USERNAME && password === STATS_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Stats API"');
  return res.status(401).json({ error: 'invalid credentials' });
}

// Get absolute path to public directory
const publicPath = path.resolve(process.cwd(), 'src', 'public');

// Root endpoint - must be before static middleware to return JSON instead of index.html
app.get('/', (req, res) => {
  logger.debug('Root endpoint requested');
  res.json({
    service: 'gronka cdn',
    endpoints: {
      health: '/health',
      stats: '/stats',
      gifs: '/gifs/{hash}.gif',
      videos: '/videos/{hash}.{ext}',
      images: '/images/{hash}.{ext}',
      terms: '/terms',
      privacy: '/privacy',
    },
  });
});

// Serve static HTML files from public directory (but not index.html at root)
app.use(
  express.static(publicPath, {
    maxAge: '1h', // Cache for 1 hour
    etag: true,
    lastModified: true,
    index: false, // Don't serve index.html automatically
  })
);

// Serve 404 cat image for /gifs/ route
app.get('/gifs', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

app.get('/gifs/', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

// Serve 404 cat image for /videos/ route
app.get('/videos', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

app.get('/videos/', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

// Serve 404 cat image for /images/ route
app.get('/images', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

app.get('/images/', cdnLimiter, (req, res) => {
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

// Helper function to serve files from a subdirectory
async function serveFileFromSubdirectory(req, res, subdirectory, defaultContentType) {
  const filename = req.params.filename;
  const subdirectoryPath = path.join(storagePath, subdirectory);

  // Validate filename to prevent path traversal
  const validation = validateFilename(filename, subdirectoryPath);
  if (!validation.valid) {
    logger.warn(`Invalid filename attempt: ${filename} - ${validation.error}`);
    res.status(400);
    res.type('image/jpeg');
    res.sendFile(path.join(publicPath, '404.jpg'));
    return;
  }

  const filePath = validation.filePath;

  try {
    // Check if file exists
    await fs.access(filePath);

    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    let contentType = defaultContentType;

    if (ext === '.gif') {
      contentType = 'image/gif';
    } else if (ext === '.mp4') {
      contentType = 'video/mp4';
    } else if (ext === '.webm') {
      contentType = 'video/webm';
    } else if (ext === '.mov') {
      contentType = 'video/quicktime';
    } else if (ext === '.avi') {
      contentType = 'video/x-msvideo';
    } else if (ext === '.mkv') {
      contentType = 'video/x-matroska';
    } else if (ext === '.png') {
      contentType = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.webp') {
      contentType = 'image/webp';
    } else if (ext === '.mp3') {
      contentType = 'audio/mpeg';
    } else if (ext === '.m4a') {
      contentType = 'audio/mp4';
    }

    // File exists, serve it with proper headers
    logger.debug(`Serving file: ${filename} from ${subdirectory} (${contentType})`);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.set('Content-Type', contentType);
    res.sendFile(filePath);
  } catch {
    // File doesn't exist, serve cat image
    logger.warn(`File not found: ${filename} in ${subdirectory}`);
    res.status(404);
    res.type('image/jpeg');
    res.sendFile(path.join(publicPath, '404.jpg'));
  }
}

// Custom handler for /gifs/* requests - check if file exists, serve cat image if not
app.get('/gifs/:filename', cdnLimiter, async (req, res) => {
  await serveFileFromSubdirectory(req, res, 'gifs', 'image/gif');
});

// Custom handler for /videos/* requests
app.get('/videos/:filename', cdnLimiter, async (req, res) => {
  await serveFileFromSubdirectory(req, res, 'videos', 'video/mp4');
});

// Custom handler for /images/* requests
app.get('/images/:filename', cdnLimiter, async (req, res) => {
  await serveFileFromSubdirectory(req, res, 'images', 'image/png');
});

/**
 * Check if FFmpeg is available
 * @returns {Promise<boolean>} True if FFmpeg is available
 */
async function checkFFmpegAvailable() {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get disk space information
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<Object>} Disk space info
 */
async function getDiskSpace(dirPath) {
  try {
    // Check if we can write to the directory
    // This is a simple check - full disk space monitoring would require platform-specific code
    await fs.access(dirPath, fs.constants.W_OK);
    return { available: true, error: null };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

/**
 * Check storage directory accessibility
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<Object>} Accessibility info
 */
async function checkStorageAccess(dirPath) {
  try {
    await fs.access(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return { accessible: true, error: null };
  } catch (error) {
    return { accessible: false, error: error.message };
  }
}

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  const uptime = process.uptime();
  logger.debug('Health check requested');

  const health = {
    status: 'ok',
    uptime: Math.floor(uptime),
    timestamp: formatTimestampSeconds(),
    components: {
      server: { status: 'ok' },
      storage: { status: 'unknown' },
      ffmpeg: { status: 'unknown' },
    },
  };

  try {
    // Check storage directory
    const storageCheck = await checkStorageAccess(storagePath);
    health.components.storage = {
      status: storageCheck.accessible ? 'ok' : 'error',
      path: storagePath,
      error: storageCheck.error || null,
    };

    // Check FFmpeg
    const ffmpegAvailable = await checkFFmpegAvailable();
    health.components.ffmpeg = {
      status: ffmpegAvailable ? 'ok' : 'error',
      available: ffmpegAvailable,
    };

    // Check disk space
    const diskSpace = await getDiskSpace(storagePath);
    health.components.disk = {
      status: diskSpace.available ? 'ok' : 'warning',
      available: diskSpace.available,
      error: diskSpace.error || null,
    };

    // Overall status
    const allOk =
      health.components.storage.status === 'ok' &&
      health.components.ffmpeg.status === 'ok' &&
      health.components.disk.status !== 'error';

    if (!allOk) {
      health.status = 'degraded';
      res.status(503);
    }
  } catch (error) {
    logger.error('Health check error:', error);
    health.status = 'error';
    health.error = error.message;
    res.status(503);
  }

  res.json(health);
});

// API health endpoint (for dashboard)
app.get('/api/health', (req, res) => {
  const uptime = process.uptime();
  logger.debug('API health check requested');
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime),
    timestamp: formatTimestampSeconds(),
  });
});

// Stats endpoint (optional) - protected with basic auth if configured
app.get('/stats', statsLimiter, basicAuth, async (req, res) => {
  try {
    logger.debug('Stats requested');
    const stats = await getStorageStats(GIF_STORAGE_PATH);
    res.json({
      total_gifs: stats.totalGifs,
      total_videos: stats.totalVideos,
      total_images: stats.totalImages,
      disk_usage_formatted: stats.diskUsageFormatted,
      gifs_disk_usage_formatted: stats.gifsDiskUsageFormatted,
      videos_disk_usage_formatted: stats.videosDiskUsageFormatted,
      images_disk_usage_formatted: stats.imagesDiskUsageFormatted,
      storage_path: storagePath,
    });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    res.status(500).json({
      error: 'failed to get stats',
      message: error.message,
    });
  }
});

// API stats endpoint (for dashboard) - protected with basic auth if configured
app.get('/api/stats', statsLimiter, basicAuth, async (req, res) => {
  try {
    logger.debug('API stats requested');
    const stats = await getStorageStats(GIF_STORAGE_PATH);
    res.json({
      total_gifs: stats.totalGifs,
      total_videos: stats.totalVideos,
      total_images: stats.totalImages,
      disk_usage_formatted: stats.diskUsageFormatted,
      gifs_disk_usage_formatted: stats.gifsDiskUsageFormatted,
      videos_disk_usage_formatted: stats.videosDiskUsageFormatted,
      images_disk_usage_formatted: stats.imagesDiskUsageFormatted,
      storage_path: storagePath,
    });
  } catch (error) {
    logger.error('Failed to get API stats:', error);
    res.status(500).json({
      error: 'failed to get stats',
      message: error.message,
    });
  }
});

// Terms of Service route
app.get('/terms', (req, res) => {
  logger.debug('Terms of Service page requested');
  res.sendFile(path.join(publicPath, 'terms.html'));
});

// Privacy Policy route
app.get('/privacy', (req, res) => {
  logger.debug('Privacy Policy page requested');
  res.sendFile(path.join(publicPath, 'privacy.html'));
});

// 404 handler - serve cat image for all unmatched routes
app.use((req, res) => {
  res.status(404);
  res.type('image/jpeg');
  res.sendFile(path.join(publicPath, '404.jpg'));
});

// Validate configuration
try {
  // Config validation happens during import
  if (!GIF_STORAGE_PATH || !SERVER_PORT) {
    throw new ConfigurationError('Required server configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Start server
app.listen(SERVER_PORT, HOST, () => {
  logger.info(`cdn server running on http://${HOST}:${SERVER_PORT}`);
  logger.info(`serving gifs from: ${storagePath}`);
  logger.info(`health check: http://${HOST}:${SERVER_PORT}/health`);
  logger.info(`stats: http://${HOST}:${SERVER_PORT}/stats`);
});

// Handle errors
app.on('error', error => {
  logger.error('Server error:', error);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
