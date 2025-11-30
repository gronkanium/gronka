import { WebSocketServer } from 'ws';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

// Store connected clients
export const clients = new Set();

// Ping/pong heartbeat configuration
const PING_INTERVAL = 30000; // 30 seconds
let pingInterval = null;

export function createWebSocketServer(httpServer) {
  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' });

  return { wss, clients };
}

export function startPingInterval(pingClientsCallback) {
  // Start ping/pong heartbeat (every 30 seconds)
  pingInterval = setInterval(() => {
    pingClientsCallback();
  }, PING_INTERVAL);
  logger.info('started WebSocket ping/pong heartbeat');
}

export function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}
