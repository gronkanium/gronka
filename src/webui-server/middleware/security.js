import net from 'node:net';

// Security headers middleware
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only include recognized Permissions-Policy features to avoid console warnings
  // Only set well-known, recognized features - omitting Privacy Sandbox features that cause warnings
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

// A DNS-rebinding page reaches us under its own hostname; we only answer to addresses and named hosts.
export function hostGuard(req, res, next) {
  const host = (req.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = (process.env.WEBUI_ALLOWED_HOSTS ?? '').toLowerCase().split(',');
  if (
    net.isIP(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    allowed.includes(host)
  ) {
    return next();
  }
  res.status(421).json({ error: 'unknown host' });
}
