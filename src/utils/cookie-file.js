import fsSync from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('cookie-file');

// cookies.json holds one cookie-header string per service, which is the shape cobalt reads and
// what instagram.js/reddit.js send verbatim. Browser extensions export Netscape cookies.txt
// instead, so this converts a pasted export into that shape rather than making a human hand-edit
// JSON — which is how a session last got installed, and why one got dropped.
export const COOKIE_SERVICES = {
  instagram: {
    label: 'Instagram',
    domains: ['instagram.com'],
    // Without these the app falls back to cobalt, which cannot do photo or carousel posts.
    required: ['sessionid', 'ds_user_id', 'csrftoken'],
    used_by: 'photo/carousel/reel downloads via instagram.js, and cobalt',
  },
  reddit: {
    label: 'Reddit',
    domains: ['reddit.com'],
    // Optional: the anonymous feed covers most posts; a session adds whole galleries.
    required: [],
    recommended: ['reddit_session'],
    used_by: 'gallery slides beyond the first (reddit.js reads the feed anonymously otherwise)',
  },
  twitter: {
    label: 'Twitter / X',
    domains: ['twitter.com', 'x.com'],
    required: [],
    recommended: ['auth_token', 'ct0'],
    used_by: 'cobalt, for age-restricted or otherwise gated posts',
  },
};

/**
 * Parse a Netscape cookies.txt export into `name=value; …`, keeping only cookies whose domain
 * matches one of `domains`.
 * @param {string} text - contents of a cookies.txt export
 * @param {string[]} domains - bare domains to keep (subdomains and a leading dot both match)
 * @returns {{ cookie: string, names: string[], skipped: number }}
 */
export function parseNetscapeCookies(text, domains) {
  const wanted = domains.map(d => d.toLowerCase());
  const matches = host => {
    const bare = host.toLowerCase().replace(/^\./, '');
    return wanted.some(d => bare === d || bare.endsWith(`.${d}`));
  };

  const pairs = new Map();
  let skipped = 0;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) {
      continue;
    }
    // Some exporters mark host-only cookies with this prefix rather than a separate column.
    const columns = line.replace(/^#HttpOnly_/, '').split('\t');
    if (columns.length < 7) {
      skipped++;
      continue;
    }
    const [host, , , , , name, ...rest] = columns;
    const value = rest.join('\t');
    if (!name || !matches(host)) {
      skipped++;
      continue;
    }
    // Later lines win, matching how a browser resolves a duplicate name.
    pairs.set(name, value);
  }

  return {
    cookie: [...pairs].map(([name, value]) => `${name}=${value}`).join('; '),
    names: [...pairs.keys()],
    skipped,
  };
}

/** Cookie names present in an already-built `name=value; …` string. */
export function cookieNames(cookie) {
  return String(cookie || '')
    .split(';')
    .map(part => part.trim().split('=')[0])
    .filter(Boolean);
}

export function readCookieFile(path) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Could not read ${path}: ${error.message}`);
    }
    return {};
  }
}

/**
 * Replace one service's entry. Every other service is left byte-for-byte alone, and the file is
 * written 600 — it holds live sessions.
 */
export function writeServiceCookie(path, service, cookie) {
  const all = readCookieFile(path);
  if (cookie) {
    all[service] = [cookie];
  } else {
    delete all[service];
  }
  fsSync.writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  try {
    fsSync.chmodSync(path, 0o600);
  } catch {
    // A bind-mounted file may refuse chmod; the content is what matters.
  }
  return all;
}

/**
 * Per-service view of a cookie file: what is installed and what is missing.
 * Values are never returned — only which names are present.
 */
export function describeCookieFile(path) {
  const all = readCookieFile(path);
  return Object.entries(COOKIE_SERVICES).map(([service, meta]) => {
    const names = cookieNames(all[service]?.[0]);
    const missing = (meta.required || []).filter(name => !names.includes(name));
    const absent = names.length === 0;
    return {
      service,
      label: meta.label,
      usedBy: meta.used_by,
      configured: !absent,
      names,
      missing,
      recommendedMissing: (meta.recommended || []).filter(name => !names.includes(name)),
      status: absent ? 'empty' : missing.length > 0 ? 'incomplete' : 'ok',
    };
  });
}
