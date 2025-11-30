import { createLogger } from '../../utils/logger.js';
import { operations } from '../operations/storage.js';
import { enrichOperationUsername } from '../operations/enrichment.js';
import { getLatestSystemMetrics } from '../../utils/database.js';
import { getAlerts } from '../../utils/database.js';

const logger = createLogger('webui');

// Clean up dead connections
export function cleanupDeadConnections(clients) {
  const deadClients = [];
  clients.forEach(client => {
    if (client.readyState !== 1) {
      // WebSocket.OPEN = 1, any other state means disconnected
      deadClients.push(client);
    }
  });

  deadClients.forEach(client => {
    logger.debug('Removing dead WebSocket connection');
    clients.delete(client);
    try {
      client.terminate();
    } catch (_err) {
      // Ignore errors when terminating
    }
  });

  if (deadClients.length > 0) {
    logger.debug(`Cleaned up ${deadClients.length} dead WebSocket connection(s)`);
  }
}

// Send ping to all connected clients and remove those that don't respond
export function pingClients(clients) {
  const clientsToRemove = [];

  clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN = 1
      // Check if client is still alive (isAlive flag set by pong handler)
      if (client.isAlive === false) {
        // Client didn't respond to previous ping
        logger.debug('WebSocket client did not respond to ping, removing');
        clientsToRemove.push(client);
        return;
      }

      // Mark as not alive, will be set to true when pong is received
      client.isAlive = false;

      try {
        // Send ping frame
        client.ping();
      } catch (err) {
        logger.error('Error sending ping to WebSocket client:', err);
        clientsToRemove.push(client);
      }
    } else {
      // Not open, mark for removal
      clientsToRemove.push(client);
    }
  });

  // Remove dead clients
  clientsToRemove.forEach(client => {
    clients.delete(client);
    try {
      client.terminate();
    } catch (_err) {
      // Ignore errors when terminating
    }
  });

  // Also clean up any other dead connections
  cleanupDeadConnections(clients);
}

// Handle WebSocket connections
export function setupWebSocketHandlers(wss, clients) {
  wss.on('connection', async ws => {
    logger.debug('WebSocket client connected');
    clients.add(ws);

    // Mark client as alive initially
    ws.isAlive = true;

    // Handle pong response - mark client as alive
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Send initial data to newly connected client
    try {
      // Enrich any operations that might have missing usernames before sending
      const enrichedOps = operations.map(op => {
        const enriched = { ...op };
        enrichOperationUsername(enriched);
        return enriched;
      });
      // Send initial operations list
      ws.send(JSON.stringify({ type: 'operations', data: enrichedOps }));

      // Send latest system metrics
      try {
        const latestMetrics = await getLatestSystemMetrics();
        if (latestMetrics) {
          ws.send(JSON.stringify({ type: 'system_metrics', data: latestMetrics }));
        }
      } catch (error) {
        logger.error('Error sending initial system metrics:', error);
      }

      // Send recent alerts (last 10)
      try {
        const recentAlerts = getAlerts({ limit: 10, offset: 0 });
        if (recentAlerts && recentAlerts.length > 0) {
          recentAlerts.forEach(alert => {
            ws.send(JSON.stringify({ type: 'alert', data: alert }));
          });
        }
      } catch (error) {
        logger.error('Error sending initial alerts:', error);
      }
    } catch (error) {
      logger.error('Error sending initial data:', error);
    }

    // Handle client disconnect
    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
      clients.delete(ws);
    });

    // Handle errors
    ws.on('error', error => {
      logger.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });
}
