import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import rateLimit from 'express-rate-limit';
import { getStorageStats } from './utils/storage.js';
import { createLogger, formatTimestampSeconds } from './utils/logger.js';
import { serverConfig, r2Config } from './utils/config.js';
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
} = serverConfig;

const app = express();

// Trust proxy for proper IP detection in Docker network
// Set to 1 to trust one proxy
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
    // Skip rate limiting only for requests from internal Docker network or localhost
    // Use req.ip which is properly handled by express 'trust proxy' setting
    // Do NOT trust X-Forwarded-For directly as it can be spoofed by attackers
    const ip = req.ip || '';
    const ipStr = String(ip);

    // Allow skip for localhost (IPv4 and IPv6)
    if (
      ipStr === '127.0.0.1' ||
      ipStr === '::1' ||
      ipStr === '::ffff:127.0.0.1' ||
      ipStr === 'localhost'
    ) {
      return true;
    }

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

// CDN limiter reserved for future use
// const cdnLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 200, // Higher limit for CDN endpoints (main purpose)
//   message: 'too many requests from this IP, please try again later',
//   standardHeaders: true,
//   legacyHeaders: false,
// });

const statsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // Allow dashboard polling (30s interval = ~30 requests per 15 min, with buffer)
  message: 'too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => {
    // Skip rate limiting only for requests from internal Docker network or localhost
    // Use req.ip which is properly handled by express 'trust proxy' setting
    // Do NOT trust X-Forwarded-For directly as it can be spoofed by attackers
    const ip = req.ip || '';
    const ipStr = String(ip);

    // Allow skip for localhost (IPv4 and IPv6)
    if (
      ipStr === '127.0.0.1' ||
      ipStr === '::1' ||
      ipStr === '::ffff:127.0.0.1' ||
      ipStr === 'localhost'
    ) {
      return true;
    }

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

// Get absolute path to GIF storage
function getStoragePath() {
  if (path.isAbsolute(GIF_STORAGE_PATH)) {
    return GIF_STORAGE_PATH;
  }
  return path.resolve(process.cwd(), GIF_STORAGE_PATH);
}

const storagePath = getStoragePath();

/**
 * Restrict endpoint to localhost/internal network only
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function restrictToInternal(req, res, next) {
  const ip = req.ip || '';
  const ipStr = String(ip);

  // Allow localhost (IPv4 and IPv6)
  if (
    ipStr === '127.0.0.1' ||
    ipStr === '::1' ||
    ipStr === '::ffff:127.0.0.1' ||
    ipStr === 'localhost'
  ) {
    return next();
  }

  // Allow Docker internal network IPs
  if (
    ipStr.startsWith('172.') ||
    ipStr.startsWith('192.168.') ||
    ipStr.startsWith('10.') ||
    ipStr.includes('::ffff:172.') ||
    ipStr.includes('::ffff:192.168.') ||
    ipStr.includes('::ffff:10.')
  ) {
    return next();
  }

  // Block external/public requests
  logger.warn(`blocked external access to ${req.path} from ${ipStr}`);
  return res.status(403).json({ error: 'access denied' });
}

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
    service: 'gronka api',
    endpoints: {
      terms: '/terms',
      privacy: '/privacy',
    },
    note: 'files are served from r2, not locally',
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

// Files are now served directly from R2, so these routes are removed
// /gifs/*, /videos/*, /images/* routes removed - files served from R2

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
 * Ensure storage directory exists
 * @param {string} dirPath - Directory path to ensure
 * @returns {Promise<void>}
 */
async function ensureStorageDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Check storage directory accessibility
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<Object>} Accessibility info
 */
async function checkStorageAccess(dirPath) {
  try {
    // Ensure directory exists before checking access
    await ensureStorageDir(dirPath);
    await fs.access(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return { accessible: true, error: null };
  } catch (error) {
    return { accessible: false, error: error.message };
  }
}

// Enhanced health check endpoint - restricted to internal network
// Placed before rate limiter to exclude from rate limiting
app.get('/health', restrictToInternal, async (req, res) => {
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

// Apply general rate limiting to all requests (after /health route)
app.use(generalLimiter);

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

// Stats endpoint (optional) - restricted to internal network and protected with basic auth if configured
app.get('/stats', restrictToInternal, statsLimiter, basicAuth, async (req, res) => {
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

    // Validate GIF_STORAGE_PATH before proceeding
    if (
      !GIF_STORAGE_PATH ||
      typeof GIF_STORAGE_PATH !== 'string' ||
      GIF_STORAGE_PATH.trim() === ''
    ) {
      logger.error('Invalid GIF_STORAGE_PATH configuration:', { GIF_STORAGE_PATH });
      return res.status(500).json({
        error: 'failed to get stats',
        message: 'Storage path is not configured',
        storage_path: null,
      });
    }

    logger.debug(`Fetching stats for storage path: ${GIF_STORAGE_PATH}`);
    const stats = await getStorageStats(GIF_STORAGE_PATH);

    if (!stats) {
      logger.error('getStorageStats returned null or undefined');
      return res.status(500).json({
        error: 'failed to get stats',
        message: 'Stats retrieval returned no data',
        storage_path: storagePath,
      });
    }

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
    logger.error('Failed to get API stats:', {
      error: error.message,
      stack: error.stack,
      storage_path: GIF_STORAGE_PATH,
      storage_path_type: typeof GIF_STORAGE_PATH,
    });
    res.status(500).json({
      error: 'failed to get stats',
      message: error.message,
      storage_path: storagePath,
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

// Get 404 cat image URL from R2 or fallback to local
function get404CatImageUrl() {
  if (r2Config.publicDomain) {
    return `https://${r2Config.publicDomain}/404.jpg`;
  }
  // Fallback: return local path (will be served as redirect or direct file)
  return path.join(publicPath, '404.jpg');
}

// 404 handler - redirect to R2 cat image URL or serve locally
app.use((req, res) => {
  res.status(404);
  const catImageUrl = get404CatImageUrl();

  // If it's an R2 URL, redirect to it
  if (catImageUrl.startsWith('http')) {
    res.redirect(catImageUrl);
  } else {
    // Fallback to local file serving
    res.type('image/jpeg');
    res.sendFile(catImageUrl);
  }
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
  logger.info(`server running on http://${HOST}:${SERVER_PORT}`);
  logger.info(`storage path: ${storagePath}`);
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
