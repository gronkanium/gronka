import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { getPostgresConnection } from '../utils/database/connection.js';
import { ensurePostgresInitialized } from '../utils/database/init.js';
import { base32Encode, decryptSecret, encryptSecret, matchTotp, otpauthUri } from './totp.js';

// Crockford base32: no I, L, O, U, so a typed number can't be misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ACCOUNT_ID_LEN = 5;
const ACCOUNT_SECRET_LEN = 26; // 130 bits
const KEY_ID_LEN = 8;
const MAX_KEYS = 10;
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const KEY_CACHE_MS = 5 * 60 * 1000;
const RECOVERY_CODES = 10;
const RECOVERY_LEN = 10;
const MAX_PASSKEYS = 10;
// Every 5th wrong code locks for 15 minutes; 100 in a row (NIST's ceiling) locks until a passkey login.
const THROTTLE_EVERY = 5;
const THROTTLE_MS = 15 * 60 * 1000;
const MAX_FAILURES = 100;
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
  await sql`
    ALTER TABLE web_accounts
      ADD COLUMN IF NOT EXISTS totp_secret TEXT,
      ADD COLUMN IF NOT EXISTS totp_pending TEXT,
      ADD COLUMN IF NOT EXISTS totp_last_step BIGINT,
      ADD COLUMN IF NOT EXISTS totp_failures INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS totp_locked_until TIMESTAMPTZ`;
  await sql`
    CREATE TABLE IF NOT EXISTS web_recovery_codes (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS web_passkeys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
      public_key BYTEA NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT[],
      label TEXT,
      created_on DATE NOT NULL DEFAULT CURRENT_DATE
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

export async function deleteOtherSessions(accountId, keepToken) {
  const sql = getPostgresConnection();
  await sql`
    DELETE FROM web_sessions
    WHERE account_id = ${accountId} AND token_hash <> ${sha256(String(keepToken))}`;
}

export async function deleteSession(token) {
  if (typeof token !== 'string') return;
  const sql = getPostgresConnection();
  await sql`DELETE FROM web_sessions WHERE token_hash = ${sha256(token)}`;
}

export async function getAccountSummary(accountId) {
  const sql = getPostgresConnection();
  const [account] =
    await sql`SELECT id, created_on, totp_secret FROM web_accounts WHERE id = ${accountId}`;
  if (!account) return null;
  const keys = await sql`
    SELECT id, label, created_on, last_used_on FROM web_api_keys
    WHERE account_id = ${accountId} ORDER BY created_on, id`;
  const passkeys = await sql`
    SELECT id, label, created_on FROM web_passkeys
    WHERE account_id = ${accountId} ORDER BY created_on, id`;
  const [{ left }] =
    await sql`SELECT count(*)::int AS left FROM web_recovery_codes WHERE account_id = ${accountId}`;
  const day = date => date?.toISOString().slice(0, 10) ?? null;
  return {
    id: account.id,
    createdOn: day(account.created_on),
    totp: account.totp_secret !== null,
    recoveryCodesLeft: left,
    keys: keys.map(key => ({
      id: `gk_${key.id}`,
      label: key.label,
      createdOn: day(key.created_on),
      lastUsedOn: day(key.last_used_on),
    })),
    passkeys: passkeys.map(key => ({
      id: key.id,
      label: key.label,
      createdOn: day(key.created_on),
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
  // The format and checksum are public, so refusing a malformed key early leaks nothing.
  if (!parsed) return null;
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

export async function startTotp(accountId) {
  const sql = getPostgresConnection();
  const secret = crypto.randomBytes(20);
  const rows = await sql`
    UPDATE web_accounts SET totp_pending = ${encryptSecret(secret, accountId)}
    WHERE id = ${accountId} AND totp_secret IS NULL RETURNING id`;
  return rows.length ? { uri: otpauthUri(secret, accountId), secret: base32Encode(secret) } : null;
}

async function createRecoveryCodes(sql, accountId) {
  const codes = Array.from({ length: RECOVERY_CODES }, () => randomBase32(RECOVERY_LEN));
  const hashes = await Promise.all(codes.map(hashSecret));
  await sql`DELETE FROM web_recovery_codes WHERE account_id = ${accountId}`;
  await sql`
    INSERT INTO web_recovery_codes ${sql(
      hashes.map(codeHash => ({ account_id: accountId, code_hash: codeHash }))
    )}`;
  return codes.map(code => `${code.slice(0, 5)}-${code.slice(5)}`);
}

export async function enableTotp(accountId, code) {
  const sql = getPostgresConnection();
  const [row] =
    await sql`SELECT totp_pending FROM web_accounts WHERE id = ${accountId} AND totp_secret IS NULL`;
  if (!row?.totp_pending) return null;
  const step = matchTotp(decryptSecret(row.totp_pending, accountId), code);
  if (step === null) return null;
  await sql`
    UPDATE web_accounts SET totp_secret = totp_pending, totp_pending = NULL,
      totp_last_step = ${step}, totp_failures = 0, totp_locked_until = NULL
    WHERE id = ${accountId}`;
  return createRecoveryCodes(sql, accountId);
}

const normalizeRecovery = input =>
  String(input).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

async function useRecoveryCode(sql, accountId, input) {
  const code = normalizeRecovery(input);
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(code)) return false;
  const rows =
    await sql`SELECT id, code_hash FROM web_recovery_codes WHERE account_id = ${accountId}`;
  for (const row of rows) {
    if (await verifySecret(code, row.code_hash)) {
      const used = await sql`DELETE FROM web_recovery_codes WHERE id = ${row.id} RETURNING id`;
      return used.length > 0;
    }
  }
  return false;
}

// 'ok' when the account has no TOTP or the code (a TOTP code or a recovery code) is right;
// otherwise 'required', 'invalid' or 'locked'.
export async function checkSecondFactor(accountId, code) {
  const sql = getPostgresConnection();
  const [row] = await sql`
    SELECT totp_secret, totp_failures, totp_locked_until > now() AS throttled
    FROM web_accounts WHERE id = ${accountId}`;
  if (!row?.totp_secret) return 'ok';
  if (row.totp_failures >= MAX_FAILURES || row.throttled) return 'locked';
  if (typeof code !== 'string' || !code.trim()) return 'required';
  // Each attempt is claimed atomically first, so parallel guesses can't all slip under the throttle.
  const [attempt] = await sql`
    UPDATE web_accounts SET totp_failures = totp_failures + 1,
      totp_locked_until = CASE WHEN (totp_failures + 1) % ${THROTTLE_EVERY} = 0
        THEN now() + ${THROTTLE_MS / 1000} * interval '1 second' ELSE totp_locked_until END
    WHERE id = ${accountId} AND totp_failures < ${MAX_FAILURES}
      AND (totp_locked_until IS NULL OR totp_locked_until <= now())
    RETURNING totp_failures, totp_last_step`;
  if (!attempt) return 'locked';
  const lastStep = attempt.totp_last_step === null ? null : Number(attempt.totp_last_step);
  const step = matchTotp(decryptSecret(row.totp_secret, accountId), code.trim(), lastStep);
  if (step !== null) {
    // The conditional update is what makes a code single-use when two logins race.
    const claimed = await sql`
      UPDATE web_accounts SET totp_last_step = ${step}, totp_failures = 0, totp_locked_until = NULL
      WHERE id = ${accountId} AND (totp_last_step IS NULL OR totp_last_step < ${step})
      RETURNING id`;
    if (claimed.length) return 'ok';
  } else if (await useRecoveryCode(sql, accountId, code)) {
    await sql`UPDATE web_accounts SET totp_failures = 0, totp_locked_until = NULL WHERE id = ${accountId}`;
    return 'ok';
  }
  return 'invalid';
}

export async function disableTotp(accountId) {
  const sql = getPostgresConnection();
  await sql`
    UPDATE web_accounts SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL,
      totp_failures = 0, totp_locked_until = NULL
    WHERE id = ${accountId}`;
  await sql`DELETE FROM web_recovery_codes WHERE account_id = ${accountId}`;
}

export async function regenerateRecoveryCodes(accountId) {
  return createRecoveryCodes(getPostgresConnection(), accountId);
}

export async function listPasskeys(accountId) {
  const sql = getPostgresConnection();
  const rows = await sql`SELECT id, transports FROM web_passkeys WHERE account_id = ${accountId}`;
  return rows.map(row => ({ id: row.id, transports: row.transports ?? undefined }));
}

export async function addPasskey(accountId, { id, publicKey, counter, transports }, label = null) {
  const sql = getPostgresConnection();
  const [{ count }] =
    await sql`SELECT count(*)::int AS count FROM web_passkeys WHERE account_id = ${accountId}`;
  if (count >= MAX_PASSKEYS) return null;
  const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 40) || null : null;
  const [row] = await sql`
    INSERT INTO web_passkeys (id, account_id, public_key, counter, transports, label)
    VALUES (${id}, ${accountId}, ${Buffer.from(publicKey)}, ${counter}, ${transports ?? null},
      ${cleanLabel})
    ON CONFLICT (id) DO NOTHING RETURNING id, label, created_on`;
  return row
    ? { id: row.id, label: row.label, createdOn: row.created_on.toISOString().slice(0, 10) }
    : null;
}

export async function getPasskey(id) {
  if (typeof id !== 'string' || id.length > 1400) return null;
  const sql = getPostgresConnection();
  const [row] = await sql`SELECT * FROM web_passkeys WHERE id = ${id}`;
  return row
    ? {
        accountId: row.account_id,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports ?? undefined,
        },
      }
    : null;
}

// A passkey login proves the device, so it also clears a TOTP lockout.
export async function usePasskey(id, counter) {
  const sql = getPostgresConnection();
  const [row] = await sql`
    UPDATE web_passkeys SET counter = ${counter} WHERE id = ${id} RETURNING account_id`;
  await sql`
    UPDATE web_accounts SET totp_failures = 0, totp_locked_until = NULL WHERE id = ${row.account_id}`;
}

export async function removePasskey(accountId, id) {
  const sql = getPostgresConnection();
  const rows =
    await sql`DELETE FROM web_passkeys WHERE id = ${id} AND account_id = ${accountId} RETURNING id`;
  return rows.length > 0;
}
