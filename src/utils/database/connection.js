import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { r2Config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

let db = null;
let initPromise = null;

/**
 * Get the database path (supports environment variable override for testing)
 * Always defaults to data-test directory when GRONKA_DB_PATH is unset to prevent
 * accidental writes to production database
 * @returns {string} Database file path
 */
export function getDbPath() {
  // If explicitly set, use it (allows tests to override with temp directories)
  if (process.env.GRONKA_DB_PATH) {
    return process.env.GRONKA_DB_PATH;
  }

  // Always use data-test when GRONKA_DB_PATH is unset to prevent accidental
  // writes to production database. Production code should always set GRONKA_DB_PATH
  // explicitly via environment variable.
  return path.join(projectRoot, 'data-test', 'gronka.db');
}

/**
 * Ensure data directory exists
 * @returns {void}
 */
export function ensureDataDir() {
  const dataDir = path.dirname(getDbPath());

  try {
    // Check if path exists and what it is
    try {
      const stats = fs.statSync(dataDir);
      if (stats.isFile()) {
        // Path exists as a file, not a directory - this is an error condition
        throw new Error(
          `Data directory path exists as a file instead of directory: ${dataDir}. ` +
            `Please remove the file or use a different path.`
        );
      }
      // Path exists as a directory, we're good
      return;
    } catch (statError) {
      // Path doesn't exist, we'll create it below
      if (statError.code !== 'ENOENT') {
        throw statError;
      }
    }

    // Create the directory
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    // Handle specific error codes
    if (error.code === 'EEXIST') {
      // Directory already exists (shouldn't happen after stat check, but handle it)
      return;
    } else if (error.code === 'ENOTDIR') {
      // Path exists but is not a directory (shouldn't happen after stat check, but handle it)
      throw new Error(
        `Data directory path exists but is not a directory: ${dataDir}. ` +
          `Please remove the file or use a different path.`
      );
    } else {
      // Re-throw other errors
      throw error;
    }
  }
}

/**
 * Get the database connection
 * @returns {Database|null} Database connection or null if not initialized
 */
export function getDb() {
  return db;
}

/**
 * Set the database connection (internal use by init.js)
 * @param {Database|null} database - Database connection to set
 * @returns {void}
 */
export function setDb(database) {
  db = database;
}

/**
 * Get the initialization promise (internal use by init.js)
 * @returns {Promise|null} Initialization promise or null
 */
export function getInitPromise() {
  return initPromise;
}

/**
 * Set the initialization promise (internal use by init.js)
 * @param {Promise|null} promise - Initialization promise to set
 * @returns {void}
 */
export function setInitPromise(promise) {
  initPromise = promise;
}

/**
 * Check if database is initialized
 * @returns {boolean} True if database is initialized
 */
export function isDbInitialized() {
  return db !== null;
}

/**
 * Get the initialization promise (for waiting on initialization)
 * @returns {Promise|null} Initialization promise or null
 */
export async function waitForInit() {
  if (db) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  if (initPromise) {
    await initPromise;
    return;
  }
}

/**
 * Get R2 public domain for URL pattern matching
 * @returns {string} R2 public domain (e.g., 'cdn.gronka.p1x.dev')
 */
export function getR2PublicDomain() {
  return r2Config.publicDomain || 'cdn.gronka.p1x.dev';
}
