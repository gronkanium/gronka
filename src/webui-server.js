// Barrel exporter - re-exports from modular webui-server structure
// This file maintains backward compatibility by providing the same entry point
// while delegating all functionality to the modular structure in ./webui-server/

// Import the modular webui-server (this triggers server startup via side effect)
// The server starts automatically when this module is imported
import './webui-server/index.js';

// Re-export broadcast functions for external use
// These are the same functions that were exported from the monolithic version
export {
  broadcastLog,
  broadcastSystemMetrics,
  broadcastAlert,
  broadcastUserMetrics,
} from './webui-server/index.js';
