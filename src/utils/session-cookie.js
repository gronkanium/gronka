import fs from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('session-cookie');

// A site's session cookie from the shared cookie file, or null. Read per call so a refreshed
// session is picked up without a restart.
export function readSessionCookie(site, marker) {
  const cookiesPath = process.env.INSTAGRAM_COOKIES_PATH;
  if (!cookiesPath) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'))?.[site]?.[0];
    return typeof entry === 'string' && entry.includes(marker) ? entry : null;
  } catch (error) {
    logger.warn(`Could not read ${site} cookies from ${cookiesPath}: ${error.message}`);
    return null;
  }
}
