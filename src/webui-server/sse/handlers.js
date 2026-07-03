import { createLogger } from '../../utils/logger.js';
import { operations } from '../operations/storage.js';
import { enrichOperationUsername } from '../operations/enrichment.js';
import { getAlerts } from '../../utils/database.js';

const logger = createLogger('webui');

// Write a single SSE event to a client response
export function sendEvent(client, type, data) {
  try {
    client.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  } catch (error) {
    logger.error('Error sending SSE event:', error);
  }
}

// Clean up dead connections (closed or destroyed responses)
export function cleanupDeadConnections(clients) {
  const deadClients = [];
  clients.forEach(client => {
    if (client.writableEnded || client.destroyed) {
      deadClients.push(client);
    }
  });

  deadClients.forEach(client => {
    logger.debug('Removing dead SSE connection');
    clients.delete(client);
  });

  if (deadClients.length > 0) {
    logger.debug(`Cleaned up ${deadClients.length} dead SSE connection(s)`);
  }
}

// Send a heartbeat comment to all connected clients and remove those that are no longer writable
export function heartbeatClients(clients) {
  clients.forEach(client => {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      return;
    }

    try {
      // SSE comment line - ignored by the client, but keeps the connection alive
      client.write(': heartbeat\n\n');
    } catch (error) {
      logger.error('Error sending SSE heartbeat:', error);
      clients.delete(client);
    }
  });

  cleanupDeadConnections(clients);
}

// Handle a new SSE connection (Express route handler)
export async function handleSseConnection(req, res, clients) {
  logger.debug('SSE client connected');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable proxy buffering (nginx)
  });
  res.flushHeaders?.();

  clients.add(res);

  // Send initial data to the newly connected client
  try {
    // Enrich any operations that might have missing usernames before sending
    const enrichedOps = await Promise.all(
      operations.map(async op => {
        const enriched = { ...op };
        await enrichOperationUsername(enriched);
        return enriched;
      })
    );
    // Send initial operations list
    sendEvent(res, 'operations', enrichedOps);

    // Send recent alerts (last 10)
    try {
      const recentAlerts = await getAlerts({ limit: 10, offset: 0 });
      if (recentAlerts && recentAlerts.length > 0) {
        recentAlerts.forEach(alert => {
          sendEvent(res, 'alert', alert);
        });
      }
    } catch (error) {
      logger.error('Error sending initial alerts:', error);
    }
  } catch (error) {
    logger.error('Error sending initial data:', error);
  }

  // Handle client disconnect
  req.on('close', () => {
    logger.debug('SSE client disconnected');
    clients.delete(res);
  });

  req.on('error', error => {
    logger.error('SSE connection error:', error);
    clients.delete(res);
  });
}
