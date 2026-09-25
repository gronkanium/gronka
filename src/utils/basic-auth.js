import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'crypto';
import { isIP } from 'net';
import { serverConfig } from './config.js';
import { getSetting } from './database.js';

// Per-process salt; scrypt equalizes lengths for timingSafeEqual and keeps password compares slow (CWE-916).
const SAFE_COMPARE_SALT = randomBytes(16);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEVICE_COOKIE = 'gronka_device';
const DEVICE_MAX_AGE_S = 400 * 24 * 60 * 60;

export const WEBUI_LOGIN_MODES = ['everyone', 'new_devices_only', 'skip_on_lan'];

function safeCompare(a, b) {
  const hashA = scryptSync(String(a), SAFE_COMPARE_SALT, 32);
  const hashB = scryptSync(String(b), SAFE_COMPARE_SALT, 32);
  return timingSafeEqual(hashA, hashB);
}

function ipv4(address) {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(v4) === 4 ? v4.split('.').map(Number) : null;
}

export function isLanAddress(address = '') {
  const v4 = ipv4(address);
  if (v4) {
    return (
      v4[0] === 10 ||
      (v4[0] === 192 && v4[1] === 168) ||
      (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31)
    );
  }
  return /^f[cd]|^fe[89ab]/i.test(address);
}

// Signed with the credentials, so changing the password forgets every remembered device.
function deviceSignature(id) {
  const key = createHash('sha256')
    .update(`${serverConfig.statsUsername}:${serverConfig.statsPassword}`)
    .digest();
  return createHmac('sha256', key).update(id).digest('base64url');
}

function hasTrustedDevice(req) {
  const value = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${DEVICE_COOKIE}=`))
    ?.slice(DEVICE_COOKIE.length + 1);
  const [id, signature] = (value || '').split('.');
  return Boolean(id && signature) && safeCompare(signature, deviceSignature(id));
}

function rememberDevice(res) {
  const id = randomBytes(18).toString('base64url');
  res.append?.(
    'Set-Cookie',
    `${DEVICE_COOKIE}=${id}.${deviceSignature(id)}; Max-Age=${DEVICE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict`
  );
}

let lastMode = 'everyone';

// A failed read keeps the last mode that loaded instead of snapping to the strictest one.
async function loginMode() {
  try {
    const mode = await getSetting('webui_login', 'everyone');
    if (WEBUI_LOGIN_MODES.includes(mode)) lastMode = mode;
  } catch {
    // keep lastMode
  }
  return lastMode;
}

// Loopback is the other process in this container; Docker-published ports arrive from the bridge, not here.
export async function basicAuth(req, res, next) {
  const address = req.socket.remoteAddress;
  if (LOOPBACK.has(address)) {
    return next();
  }

  const mode = await loginMode();
  if (mode === 'skip_on_lan' && isLanAddress(address)) {
    return next();
  }

  const { statsUsername, statsPassword } = serverConfig;
  if (!statsUsername || !statsPassword) {
    return res
      .status(403)
      .json({ error: 'set STATS_USERNAME and STATS_PASSWORD to allow remote access' });
  }

  const trusted = mode === 'new_devices_only' && hasTrustedDevice(req);
  if (trusted) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
    const separatorIndex = credentials.indexOf(':');
    const username = separatorIndex === -1 ? credentials : credentials.slice(0, separatorIndex);
    const password = separatorIndex === -1 ? '' : credentials.slice(separatorIndex + 1);
    if (safeCompare(username, statsUsername) && safeCompare(password, statsPassword)) {
      if (mode === 'new_devices_only') {
        rememberDevice(res);
      }
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="gronka"');
  return res.status(401).json({ error: 'authentication required' });
}
