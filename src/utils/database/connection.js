import postgres from 'postgres';
import fs from 'fs';

let sql = null;
let initPromise = null;
let currentDatabaseName = null;

/**
 * Check if we're running in test mode
 * @returns {boolean} True if running in test mode
 */
export function isTestMode() {
  // If FORCE_PRODUCTION_MODE is set, always return false (never test mode)
  // This allows scripts to explicitly force production database connection
  if (process.env.FORCE_PRODUCTION_MODE === 'true') {
    return false;
  }

  // Check if TEST_POSTGRES_DB is explicitly set
  if (process.env.TEST_POSTGRES_DB) {
    return true;
  }

  // Check if TEST_DATABASE_URL is set
  if (process.env.TEST_DATABASE_URL) {
    return true;
  }

  // Detect if running via node --test
  const isNodeTest = process.argv.some(arg => arg === '--test' || arg.includes('node:test'));
  if (isNodeTest) {
    return true;
  }

  return false;
}

/**
 * Check if we're running inside a Docker container
 * @returns {boolean} True if running in Docker
 */
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

/**
 * Get default PostgreSQL host based on environment
 * @returns {string} Default host ('postgres' in Docker, 'localhost' otherwise)
 */
function getDefaultPostgresHost() {
  // Always prioritize auto-detection to support both Docker and local/WSL environments
  // This ensures PROD_POSTGRES_HOST=postgres (meant for Docker) works correctly
  // when production scripts are run locally on WSL
  const autoDetectedHost = isRunningInDocker() ? 'postgres' : 'localhost';

  // Log if POSTGRES_HOST is set but being overridden by auto-detection
  if (process.env.POSTGRES_HOST && process.env.POSTGRES_HOST !== autoDetectedHost) {
    console.log(
      `[PostgreSQL] Auto-detected environment: using ${autoDetectedHost} (POSTGRES_HOST=${process.env.POSTGRES_HOST} ignored)`
    );
  }

  return autoDetectedHost;
}

/**
 * Get PostgreSQL connection configuration from environment variables
 * @returns {Object} PostgreSQL connection configuration
 */
export function getPostgresConfig() {
  const useTestConfig = isTestMode();

  // Support DATABASE_URL for full connection string
  // Check test version first if in test mode
  if (useTestConfig && process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }

  if (!useTestConfig && process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Get default host (auto-detects Docker vs local)
  // This now handles POSTGRES_HOST internally and prioritizes auto-detection
  const resolvedHost = useTestConfig
    ? process.env.TEST_POSTGRES_HOST || getDefaultPostgresHost()
    : getDefaultPostgresHost();

  console.log(
    `[PostgreSQL] Host resolution: POSTGRES_HOST=${process.env.POSTGRES_HOST}, auto-detected=${resolvedHost}`
  );

  // Support individual connection parameters
  // Use TEST_ prefixed variables if in test mode, with fallback to regular variables
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
    username: useTestConfig
      ? process.env.TEST_POSTGRES_USER || process.env.POSTGRES_USER || 'gronka'
      : process.env.POSTGRES_USER || 'gronka',
    password: useTestConfig
      ? process.env.TEST_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'gronka'
      : process.env.POSTGRES_PASSWORD || 'gronka',
    max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20', 10),
    idle_timeout: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || '30', 10),
    connect_timeout: parseInt(process.env.POSTGRES_CONNECT_TIMEOUT || '10', 10),
  };

  return config;
}

/**
 * Initialize PostgreSQL connection pool
 * @returns {Promise<postgres.Sql>} PostgreSQL connection pool
 */
export async function initPostgresConnection() {
  if (sql) {
    return sql;
  }

  // If initialization is in progress, wait for it
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  const newInitPromise = (async () => {
    try {
      const config = getPostgresConfig();
      const testMode = isTestMode();

      // Extract database name for logging and verification
      const dbName = typeof config === 'string' ? extractDbFromUrl(config) : config.database;
      currentDatabaseName = dbName;

      // Safety check: prevent tests from accidentally writing to production database
      if (testMode && dbName === 'gronka') {
        throw new Error(
          'SAFETY: Tests are attempting to connect to production database "gronka". ' +
            'Set TEST_POSTGRES_DB=gronka_test or use a different database name for tests.'
        );
      }

      // Log connection info (useful for debugging test database issues)
      const mode = testMode ? 'TEST' : 'PROD';
      const host = typeof config === 'string' ? 'from URL' : config.host;
      console.log(`[PostgreSQL] Connecting to database "${dbName}" on ${host} (${mode} mode)`);

      // Add onnotice handler to suppress verbose NOTICE logs in test mode
      const connectionOptions =
        typeof config === 'string'
          ? {
              connection: config,
              onnotice: testMode ? () => {} : undefined, // Silent in tests, default in production
            }
          : {
              ...config,
              onnotice: testMode ? () => {} : undefined, // Silent in tests, default in production
            };

      sql = postgres(connectionOptions);

      // Test the connection
      await sql`SELECT 1`;

      console.log(`[PostgreSQL] Connected successfully to "${dbName}"`);

      return sql;
    } catch (error) {
      sql = null;
      currentDatabaseName = null;
      throw new Error(`Failed to initialize PostgreSQL connection: ${error.message}`);
    }
  })();

  initPromise = newInitPromise;
  return newInitPromise;
}

/**
 * Extract database name from a PostgreSQL connection URL
 * @param {string} url - PostgreSQL connection URL
 * @returns {string} Database name
 */
function extractDbFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.slice(1) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get the current database name (for verification in tests)
 * @returns {string|null} Current database name or null if not connected
 */
export function getCurrentDatabaseName() {
  return currentDatabaseName;
}

/**
 * Assert that we're connected to a test database (not production)
 * Call this at the start of test files that use the database to fail fast if misconfigured
 * @throws {Error} If connected to production database or not in test mode
 */
export function assertTestDatabase() {
  if (!isTestMode()) {
    throw new Error(
      'SAFETY: assertTestDatabase() called but not in test mode. ' +
        'Run tests with TEST_POSTGRES_DB set or via "npm run test:safe".'
    );
  }

  if (currentDatabaseName === 'gronka') {
    throw new Error(
      'SAFETY: Tests are connected to production database "gronka". ' +
        'Set TEST_POSTGRES_DB=gronka_test to use the test database.'
    );
  }

  if (currentDatabaseName && !currentDatabaseName.includes('test')) {
    console.warn(
      `[PostgreSQL] Warning: Database "${currentDatabaseName}" doesn't contain "test" in its name. ` +
        'Consider using a name like "gronka_test" for clarity.'
    );
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

/**
 * Check if PostgreSQL connection is initialized
 * @returns {boolean} True if connection is initialized
 */
export function isPostgresInitialized() {
  return sql !== null;
}

/**
 * Close PostgreSQL connection pool
 * @returns {Promise<void>}
 */
export async function closePostgresConnection() {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
    initPromise = null;
    currentDatabaseName = null;
  }
}

/**
 * Health check for PostgreSQL connection
 * @returns {Promise<boolean>} True if connection is healthy
 */
export async function checkPostgresHealth() {
  try {
    if (!sql) {
      return false;
    }
    await sql`SELECT 1`;
    return true;
  } catch (_error) {
    return false;
  }
}
