import postgres from 'postgres';

let sql = null;
let initPromise = null;

/**
 * Get PostgreSQL connection configuration from environment variables
 * @returns {Object} PostgreSQL connection configuration
 */
export function getPostgresConfig() {
  // Support DATABASE_URL for full connection string
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Support individual connection parameters
  const config = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'gronka',
    username: process.env.POSTGRES_USER || 'gronka',
    password: process.env.POSTGRES_PASSWORD || 'gronka',
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
      sql = postgres(config);

      // Test the connection
      await sql`SELECT 1`;

      return sql;
    } catch (error) {
      sql = null;
      throw new Error(`Failed to initialize PostgreSQL connection: ${error.message}`);
    }
  })();

  initPromise = newInitPromise;
  return newInitPromise;
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
