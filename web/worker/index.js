// gronka-dl: lane 2 of gronka-web. Passes a source file through to the browser, so bytes go
// source -> Cloudflare -> user and never touch the backend. Only links signed by gronka-web
// (HMAC-SHA256 over the payload, shared STREAM_KEY) are served, so this is not an open proxy.
// Token: base64url(JSON {u: source url, h: request headers, n: filename, e: expiry unix s}) + "." + base64url(sig)

const ALLOWED_ORIGIN = 'https://web.gronka.dev';
const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const MEDIA_TYPE = /^(video|audio|image)\/[\w.+-]+$/i;
const encoder = new TextEncoder();

const fromBase64Url = text =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function verifyToken(token, key, now = Date.now()) {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  let valid;
  try {
    valid = await crypto.subtle.verify('HMAC', hmac, fromBase64Url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  if (!(payload.e * 1000 > now) || !/^https?:\/\//i.test(payload.u)) return null;
  return payload;
}

function disposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function totalSize(res) {
  const range = res.headers.get('content-range')?.match(/\/(\d+)$/);
  if (range) return Number(range[1]);
  const length = res.headers.get('content-length');
  return res.status === 200 && length ? Number(length) : null;
}

const cors = {
  'access-control-allow-origin': ALLOWED_ORIGIN,
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range',
  'access-control-expose-headers': 'content-length, content-range, content-disposition',
};

const WEB_PAGE = 'https://web.gronka.dev/';
const text = (body, status) =>
  new Response(body, {
    status,
    headers: {
      ...cors,
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(req.url);
    // Nothing lives here but signed file links, so a visitor is sent to the page.
    if (pathname === '/') return Response.redirect(WEB_PAGE, 302);
    const match = pathname.match(/^\/(f|probe)\/([\w-]+\.[\w-]+)$/);
    if (!match || !['GET', 'HEAD'].includes(req.method)) {
      return text(`nothing here. files come from ${WEB_PAGE}`, 404);
    }
    const payload = await verifyToken(match[2], env.STREAM_KEY);
    if (!payload) {
      return text(
        `this link expired (they last an hour). paste the link again at ${WEB_PAGE}`,
        403
      );
    }

    const headers = new Headers(payload.h ?? {});
    if (match[1] === 'probe') {
      headers.set('range', 'bytes=0-0');
      const res = await fetch(payload.u, { headers }).catch(() => null);
      await res?.body?.cancel();
      const ok = res?.status === 200 || res?.status === 206;
      return Response.json({ ok, status: res?.status ?? 0, size: ok ? totalSize(res) : null });
    }

    const range = req.headers.get('range');
    if (range) headers.set('range', range);
    const upstream = await fetch(payload.u, { method: req.method, headers }).catch(() => null);
    if (!upstream || !(upstream.status === 200 || upstream.status === 206)) {
      await upstream?.body?.cancel();
      return new Response('the source refused this file', { status: 502, headers: cors });
    }
    const out = new Headers(cors);
    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // Never let a source serve a page from our origin.
    const type = upstream.headers.get('content-type')?.split(';')[0].trim() ?? '';
    out.set('content-type', MEDIA_TYPE.test(type) ? type : 'application/octet-stream');
    out.set('content-disposition', disposition(payload.n || 'file'));
    out.set('content-security-policy', "default-src 'none'; sandbox");
    out.set('x-content-type-options', 'nosniff');
    out.set('referrer-policy', 'no-referrer');
    out.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
