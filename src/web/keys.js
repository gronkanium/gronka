import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { insertApiKey, getApiKeyHash, deleteApiKey } from '../utils/database/web-keys-pg.js';

// Crockford base32: no I, L, O, U.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const KEY_ID_LEN = 8;

function pepper() {
  const value = process.env.WEB_PEPPER;
  if (!value || value.length < 32) {
    throw new Error('WEB_PEPPER must be set (32+ chars)');
  }
  return value;
}

// The secret is 256 random bits, so a keyed HMAC is enough; the pepper never sits in the database.
const peppered = secret => crypto.createHmac('sha256', pepper()).update(secret).digest('hex');

// GitHub-style: a CRC32 tail lets secret scanners tell a real key from random text.
const keyChecksum = body => crc32(body).toString(16).padStart(8, '0');

export function parseApiKey(input) {
  const match =
    typeof input === 'string' &&
    input.match(/^(gk_([0-9a-hjkmnp-tv-z]{8})_([\w-]{43}))([0-9a-f]{8})$/);
  return match && keyChecksum(match[1]) === match[4] ? { id: match[2], secret: match[3] } : null;
}

export async function createApiKey() {
  const secret = crypto.randomBytes(32).toString('base64url');
  for (;;) {
    const id = Array.from(crypto.randomBytes(KEY_ID_LEN), b => ALPHABET[b & 31]).join('');
    if (await insertApiKey(id, peppered(secret))) {
      const body = `gk_${id}_${secret}`;
      return { id: `gk_${id}`, key: body + keyChecksum(body) };
    }
  }
}

export async function verifyApiKey(input) {
  const parsed = parseApiKey(input);
  // The format and checksum are public, so refusing a malformed key early leaks nothing.
  if (!parsed) return null;
  const mine = Buffer.from(peppered(parsed.secret), 'hex');
  const theirs = Buffer.from((await getApiKeyHash(parsed.id)) ?? '', 'hex');
  return mine.length === theirs.length && crypto.timingSafeEqual(mine, theirs) ? parsed.id : null;
}

export const revokeApiKey = id => deleteApiKey(id);
