// Restrict endpoint to localhost/internal network only (for admin operations)
export function restrictToInternal(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || '';
  const ipStr = String(ip);

  // Allow localhost (IPv4 and IPv6)
  if (
    ipStr === '127.0.0.1' ||
    ipStr === '::1' ||
    ipStr === '::ffff:127.0.0.1' ||
    ipStr === 'localhost' ||
    ipStr.includes('127.0.0.1')
  ) {
    return next();
  }

  // Allow Docker internal network IPs
  if (
    ipStr.startsWith('172.') ||
    ipStr.startsWith('192.168.') ||
    ipStr.startsWith('10.') ||
    ipStr.includes('::ffff:172.') ||
    ipStr.includes('::ffff:192.168.') ||
    ipStr.includes('::ffff:10.')
  ) {
    return next();
  }

  // Block external/public requests
  return res.status(403).json({ error: 'access denied - internal network only' });
}
