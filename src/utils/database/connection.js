import postgres from 'postgres';
import fs from 'fs';

let sql = null;
let initPromise = null;

export function isTestMode() {
  return process.env.NODE_ENV === 'test';
}

function isRunningInDocker() {
  try {
    // Check for .dockerenv file (most reliable indicator)
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }

    // Check for docker in /proc/1/cgroup (backup method)
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      return cgroup.includes('docker') || cgroup.includes('kubepods');
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function getDefaultPostgresHost() {
  if (process.env.POSTGRES_HOST) {
    return process.env.POSTGRES_HOST;
  }
  return isRunningInDocker() ? 'postgres' : 'localhost';
}

export function getPostgresConfig() {
  const useTestConfig = isTestMode();

  if (useTestConfig && process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }

  if (!useTestConfig && process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const resolvedHost = useTestConfig
    ? process.env.TEST_POSTGRES_HOST || getDefaultPostgresHost()
    : getDefaultPostgresHost();

  // Use TEST_ prefixed variables if in test mode, with fallback to regular variables
  const username = useTestConfig
    ? process.env.TEST_POSTGRES_USER || process.env.POSTGRES_USER || 'gronka'
    : process.env.POSTGRES_USER || 'gronka';

  // Ensure username is always set (prevent postgres.js from defaulting to system user)
  if (!username || username.trim() === '') {
    throw new Error(
      'PostgreSQL username is required. Set POSTGRES_USER or TEST_POSTGRES_USER environment variable.'
    );
  }

  const config = {
    host: resolvedHost,
    port: parseInt(
      useTestConfig
        ? process.env.TEST_POSTGRES_PORT || process.env.POSTGRES_PORT || '5432'
        : process.env.POSTGRES_PORT || '5432',
      10
    ),
    database: useTestConfig
      ? process.env.TEST_POSTGRES_DB || process.env.POSTGRES_DB || 'gronka'
      : process.env.POSTGRES_DB || 'gronka',
    username: username,
    password: useTestConfig
      ? process.env.TEST_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'gronka'
      : process.env.POSTGRES_PASSWORD || 'gronka',
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20', 10),
    // In test mode, close idle connections almost immediately so each test file's
    // process can exit as soon as its tests finish. The default 30s idle_timeout
    // otherwise keeps every test process alive ~30s past its last query.
    idle_timeout: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || (useTestConfig ? '1' : '30'), 10),
    connect_timeout: parseInt(process.env.POSTGRES_CONNECT_TIMEOUT || '10', 10),
  };

  return config;
}

export async function initPostgresConnection() {
  if (sql) {
    return sql;
  }

  if (initPromise) {
    return initPromise;
  }

  const newInitPromise = (async () => {
    try {
      const config = getPostgresConfig();
      const testMode = isTestMode();

      const dbName = typeof config === 'string' ? extractDbFromUrl(config) : config.database;

      // Safety check: prevent tests from accidentally writing to production database
      if (testMode && dbName === 'gronka') {
        throw new Error(
          'SAFETY: Tests are attempting to connect to production database "gronka". ' +
            'Set TEST_POSTGRES_DB=gronka_test or use a different database name for tests.'
        );
      }

      const mode = testMode ? 'TEST' : 'PROD';
      const host = typeof config === 'string' ? 'from URL' : config.host;
      console.log(`[PostgreSQL] Connecting to database "${dbName}" on ${host} (${mode} mode)`);

      // Add onnotice handler to suppress verbose NOTICE logs
      const suppressNotices = testMode;

      // Idempotent schema init (CREATE ... IF NOT EXISTS) emits "already exists,
      // skipping" notices on every startup, drop those, log anything else as one line
      // instead of postgres.js's default raw-object dump.
      const onnotice = suppressNotices
        ? () => {}
        : notice => {
            if (notice.message && notice.message.includes('already exists, skipping')) return;
            console.log(`[PostgreSQL] ${notice.severity}: ${notice.message}`);
          };

      let connectionOptions;
      if (typeof config === 'string') {
        try {
          const url = new URL(config);
          if (!url.username || url.username.trim() === '') {
            throw new Error(
              'PostgreSQL connection string must include username. ' +
                'Format: postgresql://username:password@host:port/database'
            );
          }
        } catch (error) {
          if (error.message.includes('username')) {
            throw error;
          }
          // If URL parsing fails for other reasons, let postgres.js handle it
        }
        connectionOptions = { onnotice };
      } else {
        if (!config.username || config.username.trim() === '') {
          throw new Error(
            'PostgreSQL username is required in connection config. ' +
              'Set POSTGRES_USER or TEST_POSTGRES_USER environment variable.'
          );
        }
        connectionOptions = {
          ...config,
          onnotice,
        };
      }

      sql =
        typeof config === 'string'
          ? postgres(config, connectionOptions)
          : postgres(connectionOptions);

      await sql`SELECT 1`;

      console.log(`[PostgreSQL] Connected successfully to "${dbName}"`);

      return sql;
    } catch (error) {
      sql = null;
      initPromise = null;
      throw new Error(`Failed to initialize PostgreSQL connection: ${error.message}`, {
        cause: error,
      });
    }
  })();

  initPromise = newInitPromise;
  return newInitPromise;
}

function extractDbFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.slice(1) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get PostgreSQL connection pool
 * @returns {postgres.Sql|null} PostgreSQL connection pool or null if not initialized
 */
export function getPostgresConnection() {
  return sql;
}

/**
 * Set PostgreSQL connection pool (internal use)
 * @param {postgres.Sql|null} connection - PostgreSQL connection pool to set
 * @returns {void}
 */
export function setPostgresConnection(connection) {
  sql = connection;
  if (connection === null) {
    initPromise = null;
  }
}

/**
 * Get the initialization promise (internal use)
 * @returns {Promise|null} Initialization promise or null
 */
export function getPostgresInitPromise() {
  return initPromise;
}

/**
 * Set the initialization promise (internal use)
 * @param {Promise|null} promise - Initialization promise to set
 * @returns {void}
 */
export function setPostgresInitPromise(promise) {
  initPromise = promise;
}

export async function closePostgresConnection() {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
    initPromise = null;
  }
}
