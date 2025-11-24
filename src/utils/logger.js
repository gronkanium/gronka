import { insertLog, initDatabase } from './database.js';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const LOG_LEVEL_NAMES = {
  0: 'DEBUG',
  1: 'INFO',
  2: 'WARN',
  3: 'ERROR',
};

// Track database initialization promise
let dbInitPromise = null;

// Callback for broadcasting logs to WebSocket clients
let logBroadcastCallback = null;

/**
 * Set callback for broadcasting logs
 * @param {Function} callback - Function to call with log entry
 */
export function setLogBroadcastCallback(callback) {
  logBroadcastCallback = callback;
}

// Format timestamp to seconds precision (removes milliseconds)
export function formatTimestampSeconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

class Logger {
  constructor(component, logLevel = 'INFO') {
    this.component = component;

    const levelName = logLevel.toUpperCase();
    this.logLevel = LOG_LEVELS[levelName] !== undefined ? LOG_LEVELS[levelName] : LOG_LEVELS.INFO;

    // Initialize database if not already done
    // Skip database initialization if GRONKA_DB_PATH is set (tests use temp DB)
    // or if we're in a test environment where database might not be available
    if (!dbInitPromise && !process.env.SKIP_DB_INIT) {
      dbInitPromise = initDatabase().catch(error => {
        // Silently fail in test environments to avoid cluttering test output
        if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
          console.error(`Failed to initialize database for logger:`, error);
        }
        return null; // Return null on error so we don't retry infinitely
      });
    }
  }

  // Sanitize user input to prevent log injection
  // Removes newlines, carriage returns, ANSI escape codes, and all control characters
  // that could be used to forge log entries or manipulate log output
  sanitizeLogInput(input) {
    if (typeof input === 'string') {
      // Remove ANSI escape codes (used for colored terminal output)
      // Remove newlines, carriage returns, tabs, and ALL other control characters
      // (0x00-0x1F and 0x7F-0x9F) to prevent log injection and log forging attacks
      return (
        input
          // eslint-disable-next-line no-control-regex
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape codes
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ') // Remove all control chars
          .trim()
      );
    }
    return input;
  }

  formatMessage(level, message, ...args) {
    const timestamp = formatTimestampSeconds();
    const levelStr = LOG_LEVEL_NAMES[level].padEnd(5);
    // Sanitize message and args to prevent log injection
    const sanitizedMessage = this.sanitizeLogInput(message);
    const formattedArgs =
      args.length > 0
        ? ' ' +
          args
            .map(arg => {
              const str = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
              return this.sanitizeLogInput(str);
            })
            .join(' ')
        : '';
    return `[${timestamp}] [${levelStr}] ${sanitizedMessage}${formattedArgs}`;
  }

  async log(level, message, ...args) {
    if (level < this.logLevel) {
      return;
    }

    const timestamp = Date.now();
    const levelName = LOG_LEVEL_NAMES[level];
    const formattedMessage = this.formatMessage(level, message, ...args);

    // Always output to console
    // Explicitly sanitize formattedMessage to prevent log injection
    // (formatMessage already sanitizes, but this ensures CodeQL recognizes the sanitization)
    console.log(this.sanitizeLogInput(formattedMessage));

    // Store in database
    // Combine message and args into the message field
    // Sanitize to prevent log injection
    const sanitizedMessage = this.sanitizeLogInput(message);
    const fullMessage =
      args.length > 0
        ? `${sanitizedMessage} ${args
            .map(arg => {
              const str = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
              return this.sanitizeLogInput(str);
            })
            .join(' ')}`
        : sanitizedMessage;

    // Write to database (wait for initialization if needed)
    try {
      if (dbInitPromise) {
        const initResult = await dbInitPromise;
        // If initialization failed, initResult will be null
        if (initResult === null) {
          return; // Skip database logging if init failed
        }
      }
      insertLog(timestamp, this.component, levelName, fullMessage);

      // Broadcast log to WebSocket clients if callback is set
      if (logBroadcastCallback) {
        try {
          logBroadcastCallback({
            timestamp,
            component: this.component,
            level: levelName,
            message: fullMessage,
          });
        } catch (error) {
          // Don't fail if broadcast fails
          console.error(`Failed to broadcast log:`, error);
        }
      }
    } catch (error) {
      // Don't fail if database write fails, but log to console
      console.error(`Failed to write log to database:`, error);
    }
  }

  debug(message, ...args) {
    return this.log(LOG_LEVELS.DEBUG, message, ...args);
  }

  info(message, ...args) {
    return this.log(LOG_LEVELS.INFO, message, ...args);
  }

  warn(message, ...args) {
    return this.log(LOG_LEVELS.WARN, message, ...args);
  }

  error(message, ...args) {
    return this.log(LOG_LEVELS.ERROR, message, ...args);
  }
}

export function createLogger(component) {
  const logLevel = process.env.LOG_LEVEL || 'INFO';
  return new Logger(component, logLevel);
}
