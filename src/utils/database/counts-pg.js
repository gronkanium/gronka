import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

const HOUR_MS = 60 * 60 * 1000;

async function db() {
  await ensurePostgresInitialized();
  return getPostgresConnection();
}

// The only usage figure gronka keeps: how many times a command ran each hour, and how it ended.
export async function countCommand(command, outcome, at = Date.now()) {
  const sql = await db();
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  await sql`
    INSERT INTO command_counts (hour, command, outcome, count) VALUES (${hour}, ${command}, ${outcome}, 1)
    ON CONFLICT (hour, command, outcome) DO UPDATE SET count = command_counts.count + 1
  `;
}

export async function getCommandTotals(since = 0) {
  const sql = await db();
  const rows = await sql`
    SELECT command, outcome, SUM(count)::int AS count FROM command_counts
    WHERE hour >= ${since} GROUP BY command, outcome ORDER BY command, outcome
  `;
  return rows;
}

// One point per hour, zero-filled, oldest first.
export async function getHourlyCounts(hours = 24) {
  const sql = await db();
  const current = Math.floor(Date.now() / HOUR_MS);
  const first = current - (hours - 1);
  const rows = await sql`
    SELECT hour, outcome, SUM(count)::int AS count FROM command_counts
    WHERE hour >= ${first * HOUR_MS} GROUP BY hour, outcome
  `;
  const series = [];
  for (let bucket = first; bucket <= current; bucket++) {
    const at = bucket * HOUR_MS;
    const here = rows.filter(r => Number(r.hour) === at);
    const count = outcome => here.find(r => r.outcome === outcome)?.count ?? 0;
    series.push({
      hour: new Date(at).toISOString(),
      count: here.reduce((sum, r) => sum + r.count, 0),
      success: count('success'),
      error: count('error'),
    });
  }
  return series;
}
