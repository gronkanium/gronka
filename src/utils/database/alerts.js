import { getDb } from './connection.js';

/**
 * Insert an alert/notification entry
 * @param {Object} alert - Alert data
 * @returns {void}
 */
export function insertAlert(alert) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  const timestamp = Date.now();
  const {
    severity,
    component,
    title,
    message,
    operationId = null,
    userId = null,
    metadata = null,
  } = alert;

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  const stmt = db.prepare(
    'INSERT INTO alerts (timestamp, severity, component, title, message, operation_id, user_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    timestamp,
    severity,
    component,
    title,
    message,
    operationId,
    userId,
    metadataStr
  );

  // Return the inserted alert record
  return {
    id: result.lastInsertRowid,
    timestamp,
    severity,
    component,
    title,
    message,
    operationId,
    userId,
    metadata: metadata ? JSON.parse(metadataStr) : null,
  };
}

/**
 * Get alerts with filtering
 * @param {Object} options - Query options
 * @param {string} [options.severity] - Filter by severity
 * @param {string} [options.component] - Filter by component
 * @param {number} [options.startTime] - Start timestamp
 * @param {number} [options.endTime] - End timestamp
 * @param {string} [options.search] - Search in title/message
 * @param {number} [options.limit] - Limit results
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Array} Array of alerts
 */
export function getAlerts(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const {
    severity = null,
    component = null,
    startTime = null,
    endTime = null,
    search = null,
    limit = null,
    offset = null,
  } = options;

  let query = 'SELECT * FROM alerts WHERE 1=1';
  const params = [];

  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  if (component) {
    query += ' AND component = ?';
    params.push(component);
  }

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
  }

  if (search) {
    query += ' AND (title LIKE ? OR message LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY timestamp DESC';

  if (limit !== null) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset !== null) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get count of alerts matching filters
 * @param {Object} options - Query options (same as getAlerts)
 * @returns {number} Total count
 */
export function getAlertsCount(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const {
    severity = null,
    component = null,
    startTime = null,
    endTime = null,
    search = null,
  } = options;

  let query = 'SELECT COUNT(*) as count FROM alerts WHERE 1=1';
  const params = [];

  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  if (component) {
    query += ' AND component = ?';
    params.push(component);
  }

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
  }

  if (search) {
    query += ' AND (title LIKE ? OR message LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result ? result.count : 0;
}
