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
