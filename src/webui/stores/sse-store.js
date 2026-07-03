/**
 * Shared SSE (Server-Sent Events) store for all webui components
 * Manages a single EventSource connection and provides reactive stores for different message types
 */

import { writable } from 'svelte/store';

// Connection state
export const connected = writable(false);
export const error = writable(null);

// Connection health monitoring
export const connectionHealth = writable({
  uptime: 0,
  reconnectCount: 0,
  lastMessageTime: null,
  lastConnectedTime: null,
  messageCount: 0,
  isOnline: navigator.onLine !== false,
});

// Data stores for different message types
export const operations = writable([]);
export const logs = writable([]);
export const alerts = writable([]);
export const userMetrics = writable(new Map()); // Map<userId, metrics>

// Internal EventSource instance
let es = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const STALE_CONNECTION_TIMEOUT = 60000; // 60 seconds - reconnect if no messages

// Connection reference counter (for multiple components using the store)
let connectionRefs = 0;
let connectionStartTime = null;
let lastMessageTime = null;
let messageCount = 0;
let healthCheckInterval = null;
let staleConnectionCheckInterval = null;
let isOnline = navigator.onLine !== false;

/**
 * Update connection health metrics
 */
function updateHealthMetrics() {
  const uptime = connectionStartTime ? Date.now() - connectionStartTime : 0;
  connectionHealth.set({
    uptime,
    reconnectCount: reconnectAttempts,
    lastMessageTime,
    lastConnectedTime: connectionStartTime,
    messageCount,
    isOnline,
  });
}

/**
 * Start health monitoring intervals
 */
function startHealthMonitoring() {
  // Update health metrics every second
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  healthCheckInterval = setInterval(() => {
    if (es && es.readyState === EventSource.OPEN) {
      updateHealthMetrics();
    }
  }, 1000);

  // Check for stale connections (no messages received). EventSource retries
  // transient drops on its own, but gives no signal for a connection that's
  // silently gone dead without the browser noticing, so we force one here.
  if (staleConnectionCheckInterval) {
    clearInterval(staleConnectionCheckInterval);
  }
  staleConnectionCheckInterval = setInterval(() => {
    if (es && es.readyState === EventSource.OPEN && lastMessageTime) {
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      if (timeSinceLastMessage > STALE_CONNECTION_TIMEOUT) {
        console.warn('SSE connection appears stale, reconnecting...');
        reconnectAttempts = 0;
        disconnect();
        if (connectionRefs > 0 && isOnline) {
          connect();
        }
      }
    }
  }, 10000); // Check every 10 seconds
}

/**
 * Stop health monitoring intervals
 */
function stopHealthMonitoring() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (staleConnectionCheckInterval) {
    clearInterval(staleConnectionCheckInterval);
    staleConnectionCheckInterval = null;
  }
}

/**
 * Connect to the SSE endpoint
 */
function connect() {
  if (es && es.readyState === EventSource.OPEN) {
    return; // Already connected
  }

  // Don't connect if offline
  if (!isOnline) {
    console.log('Device is offline, skipping SSE connection');
    return;
  }

  try {
    es = new EventSource('/api/events');

    es.onopen = () => {
      connected.set(true);
      error.set(null);
      reconnectAttempts = 0;
      connectionStartTime = Date.now();
      lastMessageTime = Date.now();
      messageCount = 0;
      updateHealthMetrics();
      startHealthMonitoring();
      console.log('SSE connected');
    };

    es.onmessage = event => {
      // Update last message time (any message, including heartbeat comments
      // which don't reach onmessage, but any real event does)
      lastMessageTime = Date.now();
      messageCount++;
      updateHealthMetrics();

      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    es.onerror = () => {
      connected.set(false);

      // EventSource enters CLOSED only when it gives up retrying (or after
      // we call close() ourselves) — anything else is a transient drop the
      // browser is already retrying, so only handle the terminal case here.
      if (es && es.readyState === EventSource.CLOSED) {
        console.error('SSE connection closed');
        error.set('connection error');
        stopHealthMonitoring();
        connectionStartTime = null;

        if (connectionRefs > 0 && isOnline) {
          scheduleReconnect();
        }
      }
    };
  } catch (err) {
    console.error('Error creating SSE connection:', err);
    error.set('failed to connect');
    connected.set(false);

    if (connectionRefs > 0 && isOnline) {
      scheduleReconnect();
    }
  }
}

/**
 * Handle incoming SSE messages
 */
function handleMessage(message) {
  switch (message.type) {
    case 'operations':
      // Initial operations list
      operations.set(message.data || []);
      break;

    case 'operation':
      // Single operation update
      operations.update(ops => {
        const index = ops.findIndex(op => op.id === message.data.id);
        if (index !== -1) {
          // Update existing operation
          ops[index] = message.data;
          return [...ops];
        } else {
          // Add new operation at the beginning
          return [message.data, ...ops].slice(0, 100); // Keep last 100
        }
      });
      break;

    case 'log':
      // New log entry
      logs.update(logList => {
        return [message.data, ...logList].slice(0, 1000); // Keep last 1000 logs
      });
      break;

    case 'alert':
      // New alert notification
      alerts.update(alertList => {
        return [message.data, ...alertList].slice(0, 500); // Keep last 500 alerts
      });
      break;

    case 'user_metrics':
      // User metrics update
      userMetrics.update(metricsMap => {
        const newMap = new Map(metricsMap);
        newMap.set(message.data.userId, message.data.metrics);
        return newMap;
      });
      break;

    default: {
      // Sanitize user-provided message type to prevent log injection. The sanitization must be
      // unconditional — a non-string type would otherwise reach the log unsanitized.
      const sanitizedType = String(message.type)
        .replace(/\n|\r/g, '')
        .replace(
          // eslint-disable-next-line no-control-regex
          /[\x00-\x1F\x7F-\x9F]/g,
          ' '
        );
      console.warn('Unknown message type:', sanitizedType);
    }
  }
}

/**
 * Schedule reconnection with exponential backoff (aggressive - never gives up)
 */
function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Don't reconnect if offline
  if (!isOnline) {
    console.log('Device is offline, pausing reconnection attempts');
    return;
  }

  // Aggressive reconnection: immediate retry on first attempt, then exponential backoff
  let delay;
  if (reconnectAttempts === 0) {
    delay = 0; // Immediate retry
  } else {
    delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );
  }

  reconnectTimeout = setTimeout(() => {
    reconnectAttempts++;
    updateHealthMetrics();

    // Only reconnect if we still have active references and are online
    if (connectionRefs > 0 && isOnline) {
      connect();
    } else if (connectionRefs > 0 && !isOnline) {
      // Still offline, schedule another check
      scheduleReconnect();
    }
  }, delay);
}

/**
 * Disconnect from the SSE endpoint
 */
function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  stopHealthMonitoring();

  if (es) {
    es.close();
    es = null;
  }

  connected.set(false);
  connectionStartTime = null;
  lastMessageTime = null;
  messageCount = 0;
  updateHealthMetrics();
}

/**
 * Handle online/offline events
 */
function handleOnline() {
  console.log('Device came online');
  isOnline = true;
  connectionHealth.update(health => ({ ...health, isOnline: true }));

  // If we have active references but no connection, try to connect
  if (connectionRefs > 0 && (!es || es.readyState !== EventSource.OPEN)) {
    reconnectAttempts = 0;
    connect();
  }
}

function handleOffline() {
  console.log('Device went offline');
  isOnline = false;
  connectionHealth.update(health => ({ ...health, isOnline: false }));
  error.set('device offline');
}

/**
 * Initialize SSE connection (call when component mounts)
 * Returns a cleanup function to call when component unmounts
 */
export function useSse() {
  connectionRefs++;

  if (connectionRefs === 1) {
    // First component using the store, establish connection
    // Set up online/offline listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initialize connection health
    updateHealthMetrics();

    // Establish connection
    connect();
  }

  // Return cleanup function
  return () => {
    connectionRefs--;

    if (connectionRefs === 0) {
      // Last component unmounted, disconnect
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      disconnect();
    }
  };
}

/**
 * Manually reconnect (useful for error recovery)
 */
export function reconnect() {
  reconnectAttempts = 0;
  error.set(null);
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  disconnect();
  if (connectionRefs > 0 && isOnline) {
    connect();
  }
}
