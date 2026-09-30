import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

// Context keys the logger stamps into metadata (see withLogContext); the only ones filterable.
export const LOG_FIELDS = ['op', 'command', 'source', 'user', 'worker', 'job'];
const FACETS = ['level', 'component', 'source', 'command', 'worker'];

async function connection() {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  if (!sql) console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
  return sql;
}

// Every process writes logs here, so this is the one place that can announce them to the webui.
export const LOG_CHANNEL = 'gronka_logs';

export async function insertLog(timestamp, component, level, message, metadata = null) {
  const sql = await connection();
  if (!sql) return;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;
  // Only the id is sent: NOTIFY payloads cap at 8000 bytes and a stack trace can exceed that.
  await sql`
    WITH row AS (
      INSERT INTO logs (timestamp, component, level, message, metadata)
      VALUES (${timestamp}, ${component}, ${level}, ${message}, ${metadataStr})
      RETURNING id
    )
    SELECT pg_notify(${LOG_CHANNEL}, id::text) FROM row
  `;
}

export async function onNewLog(fn) {
  const sql = await connection();
  if (!sql) return null;
  return sql.listen(LOG_CHANNEL, async id => {
    const [row] = await sql`SELECT * FROM logs WHERE id = ${Number(id)}`.catch(() => []);
    if (row) fn(toLog(row));
  });
}

function toLog(row) {
  let metadata = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return { ...row, timestamp: Number(row.timestamp), metadata };
}

const asList = v => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);

// `skip` leaves one facet's own filter out, so its counts show every value you could pick.
function buildWhere(options = {}, skip = null) {
  const conditions = [];
  const params = [];
  const p = value => `$${params.push(value)}`;
  const inList = (expr, values) => {
    if (values.length) conditions.push(`${expr} IN (${values.map(p).join(',')})`);
  };

  if (skip !== 'component') inList('component', asList(options.component));
  if (skip !== 'level') inList('level', asList(options.level));

  const excluded = asList(options.excludedComponents);
  if (excluded.length) conditions.push(`component NOT IN (${excluded.map(p).join(',')})`);
  for (const { component, level } of options.excludeComponentLevels || []) {
    conditions.push(`NOT (component = ${p(component)} AND level = ${p(level)})`);
  }

  if (options.startTime != null) conditions.push(`timestamp >= ${p(options.startTime)}`);
  if (options.endTime != null) conditions.push(`timestamp <= ${p(options.endTime)}`);
  if (options.search) conditions.push(`message ILIKE ${p(`%${options.search}%`)}`);

  for (const [key, values] of Object.entries(options.fields || {})) {
    if (!LOG_FIELDS.includes(key) || key === skip) continue;
    inList(`(metadata::jsonb ->> ${p(key)})`, asList(values).map(String));
  }

  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params, p };
}

/**
 * @param {Object} options
 * @param {string|string[]} [options.component]
 * @param {string|string[]} [options.level]
 * @param {number} [options.startTime] inclusive, ms
 * @param {number} [options.endTime] inclusive, ms
 * @param {string} [options.search] case-insensitive substring of message
 * @param {Object<string, string|string[]>} [options.fields] metadata filters, keys from LOG_FIELDS
 */
export async function getLogs(options = {}) {
  const sql = await connection();
  if (!sql) return [];
  const { where, params, p } = buildWhere(options);
  let query = `SELECT * FROM logs${where} ORDER BY timestamp ${options.orderDesc === false ? 'ASC' : 'DESC'}, id ${options.orderDesc === false ? 'ASC' : 'DESC'}`;
  if (options.limit != null) query += ` LIMIT ${p(options.limit)}`;
  if (options.offset != null) query += ` OFFSET ${p(options.offset)}`;

  return (await sql.unsafe(query, params)).map(toLog);
}

export async function getLogsCount(options = {}) {
  const sql = await connection();
  if (!sql) return 0;
  const { where, params } = buildWhere(options);
  const result = await sql.unsafe(`SELECT COUNT(*) AS count FROM logs${where}`, params);
  return parseInt(result[0]?.count || 0, 10);
}

export async function getLogFacets(options = {}, limit = 12) {
  const sql = await connection();
  if (!sql) return {};
  const facets = {};
  for (const facet of FACETS) {
    const { where, params, p } = buildWhere(options, facet);
    const column = LOG_FIELDS.includes(facet) ? `(metadata::jsonb ->> ${p(facet)})` : facet;
    const rows = await sql.unsafe(
      `SELECT ${column} AS value, COUNT(*) AS count FROM logs${where} GROUP BY 1 HAVING ${column} IS NOT NULL ORDER BY 2 DESC LIMIT ${p(limit)}`,
      params
    );
    facets[facet] = rows.map(r => ({ value: r.value, count: Number(r.count) }));
  }
  return facets;
}

export async function getLogHistogram(options, buckets = 48) {
  const sql = await connection();
  if (!sql) return { start: 0, size: 0, buckets: [] };
  const start = Number(options.startTime);
  const end = Number(options.endTime ?? Date.now());
  const size = Math.max(1000, Math.ceil((end - start) / buckets));
  const { where, params, p } = buildWhere({ ...options, startTime: start, endTime: end });
  const rows = await sql.unsafe(
    `SELECT FLOOR((timestamp - ${p(start)}) / ${p(size)})::int AS b, level, COUNT(*) AS count FROM logs${where} GROUP BY 1, 2`,
    params
  );
  const out = Array.from({ length: buckets }, () => ({ ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 }));
  for (const r of rows) {
    const bucket = out[Math.min(r.b, buckets - 1)];
    if (bucket && r.level in bucket) bucket[r.level] += Number(r.count);
  }
  return { start, size, buckets: out };
}

export async function getLogComponents() {
  const sql = await connection();
  if (!sql) return [];
  const results = await sql`SELECT DISTINCT component FROM logs ORDER BY component`;
  return results.map(r => r.component);
}

// Newest log line whose message matches a (case-insensitive) regex, in ms, or null.
export async function lastLogMatching(regex) {
  const sql = await connection();
  if (!sql) return null;
  const [row] = await sql`SELECT MAX(timestamp) AS at FROM logs WHERE message ~* ${regex.source}`;
  return row?.at ? Number(row.at) : null;
}
