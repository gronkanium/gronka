import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertTimestampsInArray, convertTimestampsToNumbers } from './helpers-pg.js';

export async function insertAlert(alert) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
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

  const result = await sql`
    INSERT INTO alerts (timestamp, severity, component, title, message, operation_id, user_id, metadata)
    VALUES (${timestamp}, ${severity}, ${component}, ${title}, ${message}, ${operationId}, ${userId}, ${metadataStr})
    RETURNING *
  `;

  const inserted = result[0];
  const alertRecord = {
    ...inserted,
    metadata: metadata ? JSON.parse(metadataStr) : null,
  };
  // Convert timestamp fields from strings to numbers
  return convertTimestampsToNumbers(alertRecord, ['timestamp']);
}

export async function getAlerts(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
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
    query += ` AND severity = $${params.length + 1}`;
    params.push(severity);
  }

  if (component) {
    query += ` AND component = $${params.length + 1}`;
    params.push(component);
  }

  if (startTime !== null) {
    query += ` AND timestamp >= $${params.length + 1}`;
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ` AND timestamp <= $${params.length + 1}`;
    params.push(endTime);
  }

  if (search) {
    query += ` AND (title ILIKE $${params.length + 1} OR message ILIKE $${params.length + 2})`;
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY timestamp DESC';

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const alerts = await sql.unsafe(query, params);
  // Convert timestamp fields from strings to numbers
  return convertTimestampsInArray(alerts, ['timestamp']);
}

export async function getAlertComponents() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const rows = await sql`SELECT DISTINCT component FROM alerts ORDER BY component`;
  return rows.map(row => row.component);
}

export async function getAlertsCount(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
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
    query += ` AND severity = $${params.length + 1}`;
    params.push(severity);
  }

  if (component) {
    query += ` AND component = $${params.length + 1}`;
    params.push(component);
  }

  if (startTime !== null) {
    query += ` AND timestamp >= $${params.length + 1}`;
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ` AND timestamp <= $${params.length + 1}`;
    params.push(endTime);
  }

  if (search) {
    query += ` AND (title ILIKE $${params.length + 1} OR message ILIKE $${params.length + 2})`;
    params.push(`%${search}%`, `%${search}%`);
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}
