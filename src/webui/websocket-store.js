/**
 * Shared WebSocket store for all webui components
 * Manages a single WebSocket connection and provides reactive stores for different message types
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
export const systemMetrics = writable(null);
export const alerts = writable([]);
export const userMetrics = writable(new Map()); // Map<userId, metrics>

// Internal WebSocket instance
let ws = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
// PING_INTERVAL removed - not currently used (server sends ping)
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      updateHealthMetrics();
    }
  }, 1000);

  // Check for stale connections (no messages received)
  if (staleConnectionCheckInterval) {
    clearInterval(staleConnectionCheckInterval);
  }
  staleConnectionCheckInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && lastMessageTime) {
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      if (timeSinceLastMessage > STALE_CONNECTION_TIMEOUT) {
        console.warn('WebSocket connection appears stale, reconnecting...');
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
 * Connect to WebSocket server
 */
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return; // Already connected
  }

  // Don't connect if offline
  if (!isOnline) {
    console.log('Device is offline, skipping WebSocket connection');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/ws`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connected.set(true);
      error.set(null);
      reconnectAttempts = 0;
      connectionStartTime = Date.now();
      lastMessageTime = Date.now();
      messageCount = 0;
      updateHealthMetrics();
      startHealthMonitoring();
      console.log('WebSocket connected');
    };

    ws.onmessage = event => {
      // Update last message time (any message, including pong, counts)
      lastMessageTime = Date.now();
      messageCount++;
      updateHealthMetrics();

      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (err) {
        console.error('Error parsing websocket message:', err);
      }
    };

    ws.onerror = err => {
      console.error('WebSocket error:', err);
      error.set('connection error');
      connected.set(false);
    };

    ws.onclose = event => {
      connected.set(false);
      stopHealthMonitoring();
      connectionStartTime = null;
      console.log(`WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);

      // Always attempt to reconnect if we have active references and are online
      if (connectionRefs > 0 && isOnline) {
        scheduleReconnect();
      }
    };
  } catch (err) {
    console.error('Error creating WebSocket:', err);
    error.set('failed to connect');
    connected.set(false);

    if (connectionRefs > 0 && isOnline) {
      scheduleReconnect();
    }
  }
}

/**
 * Sanitize user input to prevent log injection
 * Removes newlines, carriage returns, ANSI escape codes, and all control characters
 */
function sanitizeLogInput(input) {
  if (typeof input === 'string') {
    // Remove ANSI escape codes (used for colored terminal output)
    // Remove newlines, carriage returns, tabs, and ALL other control characters
    // (0x00-0x1F and 0x7F-0x9F) to prevent log injection and log forging attacks
    return (
      input
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape codes
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ') // Remove all control chars
        .trim()
    );
  }
  return input;
}

/**
 * Handle incoming WebSocket messages
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

    case 'system_metrics':
      // System metrics update
      systemMetrics.set(message.data);
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
      // Sanitize user-provided message type to prevent log injection
      const sanitizedType = sanitizeLogInput(message.type);
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
 * Disconnect from WebSocket server
 */
function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  stopHealthMonitoring();

  if (ws) {
    ws.close();
    ws = null;
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
  if (connectionRefs > 0 && (!ws || ws.readyState !== WebSocket.OPEN)) {
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
 * Initialize WebSocket connection (call when component mounts)
 * Returns a cleanup function to call when component unmounts
 */
export function useWebSocket() {
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

/**
 * Check connection status and reconnect if needed
 */
export function ensureConnected() {
  if (connectionRefs > 0 && isOnline && (!ws || ws.readyState !== WebSocket.OPEN)) {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      // Already connecting, wait
      return;
    }
    reconnectAttempts = 0;
    connect();
  }
}
