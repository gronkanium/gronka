import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { getPostgresConnection } from '../utils/database/connection.js';
import { ensurePostgresInitialized } from '../utils/database/init.js';

// Crockford base32: no I, L, O, U, so a typed number can't be misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ACCOUNT_ID_LEN = 5;
const ACCOUNT_SECRET_LEN = 26; // 130 bits
const KEY_ID_LEN = 8;
const MAX_KEYS = 10;
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const KEY_CACHE_MS = 5 * 60 * 1000;
// OWASP's m=46 MiB, t=1 set: 32 ms on traptop. The secrets are 130+ bits random, so this is defence in depth.
const ARGON = { algorithm: 'argon2id', memoryCost: 47104, timeCost: 1 };

function randomBase32(length) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => ALPHABET[b & 31]).join('');
}

function pepper() {
  const value = process.env.WEB_PEPPER;
  if (!value || value.length < 32) {
    throw new Error('WEB_PEPPER must be set (32+ chars)');
  }
  return value;
}

const peppered = secret => crypto.createHmac('sha256', pepper()).update(secret).digest('hex');
const hashSecret = secret => Bun.password.hash(peppered(secret), ARGON);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

let dummyHash;
// A miss costs the same as a wrong secret, so response time can't reveal which ids exist.
async function verifySecret(secret, hash) {
  if (!hash) {
    dummyHash ??= await hashSecret('dummy');
    await Bun.password.verify(peppered(secret), dummyHash);
    return false;
  }
  return Bun.password.verify(peppered(secret), hash);
}

export function formatAccountNumber(id, secret) {
  return `GW-${id}-${secret.match(/.{1,5}/g).join('-')}`;
}

export function parseAccountNumber(input) {
  if (typeof input !== 'string' || input.length > 100) return null;
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const match = clean.match(/^GW([0-9A-HJKMNP-TV-Z]{5})([0-9A-HJKMNP-TV-Z]{26})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}

// GitHub-style: a CRC32 tail lets secret scanners tell a real key from random text.
const keyChecksum = body => crc32(body).toString(16).padStart(8, '0');

export function parseApiKey(input) {
  const match =
    typeof input === 'string' &&
    input.match(/^(gk_([0-9a-hjkmnp-tv-z]{8})_([\w-]{43}))([0-9a-f]{8})$/);
  return match && keyChecksum(match[1]) === match[4] ? { id: match[2], secret: match[3] } : null;
}

export async function ensureWebSchema() {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  await sql`
    CREATE TABLE IF NOT EXISTS web_accounts (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      created_on DATE NOT NULL DEFAULT CURRENT_DATE
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      absolute_at TIMESTAMPTZ NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS web_api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL,
      label TEXT,
      created_on DATE NOT NULL DEFAULT CURRENT_DATE,
      last_used_on DATE
    )`;
}

export async function createAccount() {
  const sql = getPostgresConnection();
  const secret = randomBase32(ACCOUNT_SECRET_LEN);
  const secretHash = await hashSecret(secret);
  for (;;) {
    const id = randomBase32(ACCOUNT_ID_LEN);
    const rows = await sql`
      INSERT INTO web_accounts (id, secret_hash) VALUES (${id}, ${secretHash})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (rows.length) {
      return { id, number: formatAccountNumber(id, secret) };
    }
  }
}

export async function verifyAccountNumber(input) {
  const parsed = parseAccountNumber(input);
  const sql = getPostgresConnection();
  const [row] = parsed
    ? await sql`SELECT secret_hash FROM web_accounts WHERE id = ${parsed.id}`
    : [];
  const ok = await verifySecret(parsed?.secret ?? 'invalid', row?.secret_hash);
  return ok ? parsed.id : null;
}

export async function rotateAccountNumber(accountId) {
  const sql = getPostgresConnection();
  const secret = randomBase32(ACCOUNT_SECRET_LEN);
  await sql`UPDATE web_accounts SET secret_hash = ${await hashSecret(secret)} WHERE id = ${accountId}`;
  return formatAccountNumber(accountId, secret);
}

const keyCache = new Map();

export async function deleteAccount(accountId) {
  const sql = getPostgresConnection();
  await sql`DELETE FROM web_accounts WHERE id = ${accountId}`;
  for (const [cacheKey, entry] of keyCache) {
    if (entry.accountId === accountId) keyCache.delete(cacheKey);
  }
}

export async function createSession(accountId) {
  const sql = getPostgresConnection();
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`DELETE FROM web_sessions WHERE expires_at < now()`;
  await sql`
    INSERT INTO web_sessions (token_hash, account_id, expires_at, absolute_at)
    VALUES (${sha256(token)}, ${accountId}, ${new Date(Date.now() + SESSION_IDLE_MS)},
      ${new Date(Date.now() + SESSION_MS)})`;
  return token;
}

export async function getSessionAccount(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const sql = getPostgresConnection();
  // Idle for a day or older than a week, whichever comes first; each use pushes the idle limit.
  const [row] = await sql`
    UPDATE web_sessions
    SET expires_at = least(now() + ${SESSION_IDLE_MS / 1000} * interval '1 second', absolute_at)
    WHERE token_hash = ${sha256(token)} AND expires_at > now()
    RETURNING account_id`;
  return row?.account_id ?? null;
}

export async function deleteSession(token) {
  if (typeof token !== 'string') return;
  const sql = getPostgresConnection();
  await sql`DELETE FROM web_sessions WHERE token_hash = ${sha256(token)}`;
}

export async function getAccountSummary(accountId) {
  const sql = getPostgresConnection();
  const [account] = await sql`SELECT id, created_on FROM web_accounts WHERE id = ${accountId}`;
  if (!account) return null;
  const keys = await sql`
    SELECT id, label, created_on, last_used_on FROM web_api_keys
    WHERE account_id = ${accountId} ORDER BY created_on, id`;
  const day = date => date?.toISOString().slice(0, 10) ?? null;
  return {
    id: account.id,
    createdOn: day(account.created_on),
    keys: keys.map(key => ({
      id: `gk_${key.id}`,
      label: key.label,
      createdOn: day(key.created_on),
      lastUsedOn: day(key.last_used_on),
    })),
  };
}

export async function createApiKey(accountId, label = null) {
  const sql = getPostgresConnection();
  const [{ count }] =
    await sql`SELECT count(*)::int AS count FROM web_api_keys WHERE account_id = ${accountId}`;
  if (count >= MAX_KEYS) return null;
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = await hashSecret(secret);
  const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 40) || null : null;
  for (;;) {
    const id = randomBase32(KEY_ID_LEN).toLowerCase();
    const rows = await sql`
      INSERT INTO web_api_keys (id, account_id, secret_hash, label)
      VALUES (${id}, ${accountId}, ${secretHash}, ${cleanLabel})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (rows.length) {
      const body = `gk_${id}_${secret}`;
      return { id: `gk_${id}`, key: body + keyChecksum(body) };
    }
  }
}

export async function revokeApiKey(accountId, publicId) {
  const id = String(publicId).replace(/^gk_/, '');
  const sql = getPostgresConnection();
  const rows = await sql`
    DELETE FROM web_api_keys WHERE id = ${id} AND account_id = ${accountId} RETURNING id`;
  for (const [cacheKey, entry] of keyCache) {
    if (entry.keyId === id) keyCache.delete(cacheKey);
  }
  return rows.length > 0;
}

// argon2 runs once per key per 5 minutes, so a script making many calls doesn't pay for it each time.
export async function verifyApiKey(input) {
  const cacheKey = sha256(String(input));
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached;
  }
  const parsed = parseApiKey(input);
  const sql = getPostgresConnection();
  const [row] = parsed
    ? await sql`SELECT account_id, secret_hash FROM web_api_keys WHERE id = ${parsed.id}`
    : [];
  if (!(await verifySecret(parsed?.secret ?? 'invalid', row?.secret_hash))) {
    return null;
  }
  await sql`
    UPDATE web_api_keys SET last_used_on = CURRENT_DATE
    WHERE id = ${parsed.id} AND last_used_on IS DISTINCT FROM CURRENT_DATE`;
  const entry = { keyId: parsed.id, accountId: row.account_id, expires: Date.now() + KEY_CACHE_MS };
  keyCache.set(cacheKey, entry);
  return entry;
}
