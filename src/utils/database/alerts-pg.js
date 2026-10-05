import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertTimestampsInArray, convertTimestampsToNumbers } from './helpers-pg.js';

export async function insertAlert(alert) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const timestamp = Date.now();
  const { severity, component, title, message, metadata = null } = alert;

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  const result = await sql`
    INSERT INTO alerts (timestamp, severity, component, title, message, metadata)
    VALUES (${timestamp}, ${severity}, ${component}, ${title}, ${message}, ${metadataStr})
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

// `metadata` is a TEXT column holding the JSON written by insertAlert, so the two
// fields worth filtering on have to be dug back out of it.
const COMMAND_EXPR = "metadata::jsonb->>'command'";
const REASON_EXPR = "NULLIF(metadata::jsonb->>'error', '')";
const CAUSE_EXPR = "NULLIF(metadata::jsonb->>'cause', '')";
// The error class, or an early refusal's reason code.
const ERROR_CLASS_EXPR = "NULLIF(metadata::jsonb->>'errorClass', '')";

// Sentinel for failures logged without an error string, a real bucket, not an absence.
export const UNKNOWN_REASON = '__no_reason__';

function buildAlertWhere(options = {}) {
  const params = [];
  let clause = 'WHERE 1=1';

  const bind = value => {
    params.push(value);
    return `$${params.length}`;
  };

  if (options.severity) clause += ` AND severity = ${bind(options.severity)}`;
  if (options.component) clause += ` AND component = ${bind(options.component)}`;
  if (options.command) clause += ` AND ${COMMAND_EXPR} = ${bind(options.command)}`;

  if (options.reason === UNKNOWN_REASON) {
    clause += ` AND ${REASON_EXPR} IS NULL`;
  } else if (options.reason) {
    clause += ` AND ${REASON_EXPR} = ${bind(options.reason)}`;
  }

  if (options.cause) clause += ` AND ${CAUSE_EXPR} = ${bind(options.cause)}`;

  if (options.startTime !== null && options.startTime !== undefined) {
    clause += ` AND timestamp >= ${bind(options.startTime)}`;
  }
  if (options.endTime !== null && options.endTime !== undefined) {
    clause += ` AND timestamp <= ${bind(options.endTime)}`;
  }

  if (options.search) {
    const placeholder = bind(`%${options.search}%`);
    clause += ` AND (title ILIKE ${placeholder} OR message ILIKE ${placeholder} OR metadata ILIKE ${placeholder})`;
  }

  return { clause, params };
}

export async function getAlerts(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const { limit = null, offset = null } = options;
  const { clause, params } = buildAlertWhere(options);

  let query = `SELECT * FROM alerts ${clause} ORDER BY timestamp DESC`;

  if (limit !== null) {
    params.push(limit);
    query += ` LIMIT $${params.length}`;
  }

  if (offset !== null) {
    params.push(offset);
    query += ` OFFSET $${params.length}`;
  }

  const alerts = await sql.unsafe(query, params);
  // Convert timestamp fields from strings to numbers
  return convertTimestampsInArray(alerts, ['timestamp']);
}

// Aggregates over the whole filtered window, not just the current page: severity totals, a per-command split, and the top failure reasons
export async function getAlertSummary(options = {}) {
  await ensurePostgresInitialized();

  const empty = {
    total: 0,
    errors: 0,
    info: 0,
    warnings: 0,
    byCommand: [],
    byReason: [],
    byCause: [],
  };

  const sql = getPostgresConnection();

  const { reasonLimit = 25 } = options;
  const { clause, params } = buildAlertWhere(options);

  const groupSql = expr => `SELECT ${expr} AS reason,
            COUNT(*)::int AS count,
            MAX(timestamp) AS last_seen,
            MIN(timestamp) AS first_seen,
            ARRAY_AGG(timestamp) AS times,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${COMMAND_EXPR}), NULL) AS commands,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${ERROR_CLASS_EXPR}), NULL) AS classes
     FROM alerts ${clause} AND severity = 'error'
     GROUP BY 1
     ORDER BY 2 DESC
     LIMIT $${params.length + 1}`;

  const [severityRows, reasonRows, causeRows] = await Promise.all([
    sql.unsafe(
      `SELECT severity, ${COMMAND_EXPR} AS command, COUNT(*)::int AS count
     FROM alerts ${clause}
     GROUP BY 1, 2`,
      params
    ),
    sql.unsafe(groupSql(REASON_EXPR), [...params, reasonLimit]),
    sql.unsafe(groupSql(CAUSE_EXPR), [...params, reasonLimit]),
  ]);

  const summary = { ...empty, byCommand: [], byReason: [], byCause: [] };
  const byCommand = new Map();

  for (const row of severityRows) {
    summary.total += row.count;
    if (row.severity === 'error') summary.errors += row.count;
    else if (row.severity === 'warning') summary.warnings += row.count;
    else if (row.severity === 'info') summary.info += row.count;

    const entry = byCommand.get(row.command) ?? {
      command: row.command,
      total: 0,
      errors: 0,
      info: 0,
    };
    entry.total += row.count;
    if (row.severity === 'error') entry.errors += row.count;
    else if (row.severity === 'info') entry.info += row.count;
    byCommand.set(row.command, entry);
  }

  summary.byCommand = [...byCommand.values()].sort(
    (a, b) => b.errors - a.errors || b.total - a.total
  );
  const shape = row => ({
    reason: row.reason,
    count: row.count,
    commands: row.commands ?? [],
    classes: row.classes ?? [],
    lastSeen: Number(row.last_seen),
    firstSeen: Number(row.first_seen),
    times: row.times.map(Number),
  });
  summary.byReason = reasonRows.map(shape);
  summary.byCause = causeRows.map(shape);

  return summary;
}

export async function getAlertComponents() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const rows = await sql`SELECT DISTINCT component FROM alerts ORDER BY component`;
  return rows.map(row => row.component);
}

export async function getAlertCommands() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const rows = await sql.unsafe(
    `SELECT DISTINCT ${COMMAND_EXPR} AS command FROM alerts
     WHERE ${COMMAND_EXPR} IS NOT NULL ORDER BY 1`
  );
  return rows.map(row => row.command);
}

export async function getAlertsCount(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const { clause, params } = buildAlertWhere(options);
  const result = await sql.unsafe(`SELECT COUNT(*) as count FROM alerts ${clause}`, params);
  return parseInt(result[0]?.count || 0, 10);
}
