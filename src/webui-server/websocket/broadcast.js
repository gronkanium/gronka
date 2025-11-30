import { createLogger } from '../../utils/logger.js';

const logger = createLogger('webui');

// Broadcast function to send updates to all connected clients
export function broadcastOperation(clients, operation) {
  const message = JSON.stringify({ type: 'operation', data: operation });
  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending websocket message:', error);
      }
    }
  });
}

// Broadcast function to send log updates to all connected clients
export function broadcastLog(clients, logEntry) {
  const message = JSON.stringify({ type: 'log', data: logEntry });
  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending log websocket message:', error);
      }
    }
  });
}

// Broadcast function to send system metrics updates
export function broadcastSystemMetrics(clients, metrics) {
  const message = JSON.stringify({ type: 'system_metrics', data: metrics });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending system metrics websocket message:', error);
      }
    }
  });
}

// Broadcast function to send alert notifications
export function broadcastAlert(clients, alert) {
  const message = JSON.stringify({ type: 'alert', data: alert });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending alert websocket message:', error);
      }
    }
  });
}

// Broadcast function to send user metrics updates
export function broadcastUserMetrics(clients, userId, metrics) {
  const message = JSON.stringify({ type: 'user_metrics', data: { userId, metrics } });
  clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Error sending user metrics websocket message:', error);
      }
    }
  });
}
