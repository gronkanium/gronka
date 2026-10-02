import fs from 'node:fs/promises';

// Which cookie proves a login, per service. Only names, presence, expiry and file age leave
// this module: never a cookie value.
const HEADER_SESSIONS = [
  ['instagram', 'Instagram', 'sessionid'],
  ['twitter', 'X / Twitter', 'auth_token'],
  ['reddit', 'Reddit', 'reddit_session'],
];
const JAR_SESSIONS = [
  ['youtube.com', 'YouTube', ['__Secure-3PSID', 'SID', 'LOGIN_INFO']],
  ['tiktok.com', 'TikTok', ['sessionid', 'sid_tt']],
];

async function statOf(path) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

// cookies.json: { service: ["name=value; name=value", ...] }
export function headerSessions(json) {
  return HEADER_SESSIONS.map(([id, label, key]) => {
    const names = (json?.[id] ?? [])
      .flatMap(h => String(h).split(';'))
      .map(kv => kv.split('=')[0].trim())
      .filter(Boolean);
    return {
      id,
      label,
      file: 'cookies.json',
      cookies: names.length,
      loggedIn: names.includes(key),
      expires: null,
    };
  });
}

// Netscape jar: domain, flag, path, secure, expires, name, value (tab separated).
export function jarSessions(text) {
  const rows = String(text)
    .split('\n')
    .map(l => l.split('\t'))
    .filter(f => f.length === 7)
    .map(([domain, , , , expires, name]) => ({
      domain: domain.replace(/^#HttpOnly_/, ''),
      expires: Number(expires),
      name,
    }));
  return JAR_SESSIONS.map(([domain, label, keys]) => {
    const mine = rows.filter(r => r.domain === domain || r.domain.endsWith(`.${domain}`));
    const auth = mine.filter(r => keys.includes(r.name));
    const expiry = auth.map(r => r.expires).filter(e => e > 0);
    return {
      id: domain.split('.')[0],
      label,
      file: 'ytdlp-cookies.txt',
      cookies: mine.length,
      loggedIn: auth.length > 0,
      expires: expiry.length ? Math.min(...expiry) * 1000 : null,
    };
  });
}

export async function readSessions({ cookiesPath, jarPath }) {
  const [cStat, jStat] = await Promise.all([statOf(cookiesPath), statOf(jarPath)]);
  const json = cStat ? JSON.parse(await fs.readFile(cookiesPath, 'utf8').catch(() => '{}')) : null;
  const text = jStat ? await fs.readFile(jarPath, 'utf8').catch(() => '') : '';
  return [
    ...headerSessions(json).map(s => ({
      ...s,
      fileChanged: cStat?.mtimeMs ?? null,
      fileFound: !!cStat,
    })),
    ...jarSessions(text).map(s => ({
      ...s,
      fileChanged: jStat?.mtimeMs ?? null,
      fileFound: !!jStat,
    })),
  ];
}
