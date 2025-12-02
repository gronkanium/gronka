// Barrel export file - exports all functions from PostgreSQL implementation
// This file maintains the same API as before the refactoring
// Now exclusively uses PostgreSQL implementation

// Database initialization
export {
  initPostgresDatabase as initDatabase,
  closePostgresDatabase as closeDatabase,
  ensurePostgresInitialized as ensureDbInitialized,
} from './database/init.js';

// Export operations directly from PostgreSQL implementations
export * from './database/logs-pg.js';
export * from './database/users-pg.js';
export * from './database/processed-urls-pg.js';
export * from './database/operations-pg.js';
export * from './database/metrics-pg.js';
export * from './database/alerts-pg.js';
export * from './database/temporary-uploads-pg.js';

// Test helpers (for cleaning database state in tests)
export * from './database/test-helpers.js';
