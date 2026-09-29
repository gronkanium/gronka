import crypto from 'node:crypto';

// RFC 6238 defaults every authenticator app assumes: SHA-1, 6 digits, 30 s steps.
export const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map(chunk => BASE32[parseInt(chunk.padEnd(5, '0'), 2)])
    .join('');
}

export function hotp(secret, counter, digits = DIGITS, algorithm = 'sha1') {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// Returns the matched step (so the caller can refuse it next time), or null.
export function matchTotp(secret, code, lastStep = null, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  let matched = null;
  for (const candidate of [step - 1, step, step + 1]) {
    const equal = crypto.timingSafeEqual(Buffer.from(hotp(secret, candidate)), Buffer.from(code));
    if (equal && (lastStep === null || candidate > lastStep)) matched = candidate;
  }
  return matched;
}

export function otpauthUri(secret, accountId) {
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer: 'gronka',
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/gronka:${accountId}?${params}`;
}

// Ciphertext layout: version byte, 12-byte nonce, AES-256-GCM ciphertext, 16-byte tag.
const KEY_VERSION = 1;

function encryptionKey(version) {
  const raw = version === KEY_VERSION ? process.env.WEB_ENC_KEY?.trim() : null;
  const key = !raw
    ? null
    : /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
  if (key?.length !== 32) {
    throw new Error(`WEB_ENC_KEY must be 32 bytes (hex or base64) for key version ${version}`);
  }
  return key;
}

export function encryptSecret(secret, accountId) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(KEY_VERSION), nonce);
  cipher.setAAD(Buffer.from(accountId));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), nonce, body, cipher.getAuthTag()]).toString(
    'base64'
  );
}

export function decryptSecret(stored, accountId) {
  const data = Buffer.from(stored, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(data[0]),
    data.subarray(1, 13)
  );
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(13, data.length - 16)), decipher.final()]);
}
