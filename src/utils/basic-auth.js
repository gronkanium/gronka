import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { serverConfig } from './config.js';

// Per-process salt; scrypt equalizes lengths for timingSafeEqual and keeps password compares slow (CWE-916).
const SAFE_COMPARE_SALT = randomBytes(16);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeCompare(a, b) {
  const hashA = scryptSync(String(a), SAFE_COMPARE_SALT, 32);
  const hashB = scryptSync(String(b), SAFE_COMPARE_SALT, 32);
  return timingSafeEqual(hashA, hashB);
}

// Loopback is the other process in this container; Docker-published ports arrive from the bridge, not here.
export function basicAuth(req, res, next) {
  if (LOOPBACK.has(req.socket.remoteAddress)) {
    return next();
  }

  const { statsUsername, statsPassword } = serverConfig;
  if (!statsUsername || !statsPassword) {
    return res
      .status(403)
      .json({ error: 'set STATS_USERNAME and STATS_PASSWORD to allow remote access' });
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
    const separatorIndex = credentials.indexOf(':');
    const username = separatorIndex === -1 ? credentials : credentials.slice(0, separatorIndex);
    const password = separatorIndex === -1 ? '' : credentials.slice(separatorIndex + 1);
    if (safeCompare(username, statsUsername) && safeCompare(password, statsPassword)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="gronka"');
  return res.status(401).json({ error: 'authentication required' });
}
