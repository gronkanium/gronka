import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

// Store connected SSE clients (each entry is the raw Express response object)
export const clients = new Set();

// Heartbeat configuration - keeps proxies/load balancers from timing out the connection
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
let heartbeatInterval = null;

export function startHeartbeatInterval(heartbeatClientsCallback) {
  heartbeatInterval = setInterval(() => {
    heartbeatClientsCallback();
  }, HEARTBEAT_INTERVAL);
  logger.info('started SSE heartbeat');
}

export function stopHeartbeatInterval() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
