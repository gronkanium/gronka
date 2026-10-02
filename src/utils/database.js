// Barrel export file - exports all functions from PostgreSQL implementation
// This file maintains the same API as before the refactoring
// Now exclusively uses PostgreSQL implementation

// Database initialization
export {
  initPostgresDatabase as initDatabase,
  closePostgresDatabase as closeDatabase,
} from './database/init.js';

// Export operations directly from PostgreSQL implementations
export * from './database/alerts-pg.js';
export * from './database/counts-pg.js';
export * from './database/settings-pg.js';
