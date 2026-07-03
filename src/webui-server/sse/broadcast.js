import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

function broadcast(clients, type, data, errorMessage) {
  const message = `data: ${JSON.stringify({ type, data })}\n\n`;
  clients.forEach(client => {
    if (!client.writableEnded && !client.destroyed) {
      try {
        client.write(message);
      } catch (error) {
        logger.error(errorMessage, error);
      }
    }
  });
}

// Broadcast function to send updates to all connected clients
export function broadcastOperation(clients, operation) {
  broadcast(clients, 'operation', operation, 'Error sending operation SSE event:');
}

// Broadcast function to send log updates to all connected clients
export function broadcastLog(clients, logEntry) {
  broadcast(clients, 'log', logEntry, 'Error sending log SSE event:');
}

// Broadcast function to send alert notifications
export function broadcastAlert(clients, alert) {
  broadcast(clients, 'alert', alert, 'Error sending alert SSE event:');
}

// Broadcast function to send user metrics updates
export function broadcastUserMetrics(clients, userId, metrics) {
  broadcast(clients, 'user_metrics', { userId, metrics }, 'Error sending user metrics SSE event:');
}
