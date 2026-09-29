export const API = 'https://api.gronka.dev';
const SITEKEY = '0x4AAAAAAFIbeErYVDJKfBhV';
const TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export const $ = sel => document.querySelector(sel);
export const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function icon(name) {
  return `<svg class="i" aria-hidden="true"><use href="/i.svg#${name}"/></svg>`;
}

export class ApiError extends Error {
  constructor(code, message, status, retryAfter) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Whitespace heartbeats may precede the JSON, which JSON.parse already tolerates.
export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('OFFLINE', "can't reach gronka right now.", 0);
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new ApiError(
      'OFFLINE',
      res.ok
        ? 'the connection dropped before gronka answered.'
        : "the server that fetches files isn't answering right now.",
      res.status
    );
  }
  const error = data?.error;
  if (!res.ok || error) {
    const retry = Number(error?.retryAfter ?? res.headers.get('retry-after')) || null;
    throw new ApiError(
      error?.code ?? 'INTERNAL',
      error?.message ?? 'something broke.',
      res.status,
      retry
    );
  }
  return data;
}

export async function online() {
  try {
    const res = await fetch(`${API}/v1/health`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

let loader;
function loadTurnstile() {
  loader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_JS;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      loader = null;
      reject(
        new ApiError(
          'VERIFY_BLOCKED',
          "cloudflare's check didn't load. an ad blocker or a strict network can do that.",
          0
        )
      );
    };
    document.head.append(script);
  });
  return loader;
}

export const warmTurnstile = () => loadTurnstile().catch(() => {});

// Tokens are single use, so every request renders a fresh invisible widget.
export async function turnstileToken(action, box) {
  await loadTurnstile();
  return new Promise((resolve, reject) => {
    let id;
    const done = (fn, value) => {
      clearTimeout(timer);
      try {
        window.turnstile.remove(id);
      } catch {
        // already gone
      }
      box.hidden = true;
      fn(value);
    };
    const timer = setTimeout(
      () =>
        done(
          reject,
          new ApiError(
            'VERIFY_SLOW',
            "cloudflare's check is taking too long. try another network or turn off strict extensions.",
            0
          )
        ),
      30000
    );
    box.hidden = false;
    id = window.turnstile.render(box, {
      sitekey: SITEKEY,
      action,
      appearance: 'interaction-only',
      'refresh-expired': 'never',
      callback: token => done(resolve, token),
      'error-callback': () =>
        done(
          reject,
          new ApiError(
            'VERIFICATION_FAILED',
            "cloudflare couldn't check this browser. reload and try again.",
            0
          )
        ),
    });
  });
}

export function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function mb(bytes) {
  if (bytes == null) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} kb`
    : `${(bytes / 1024 / 1024).toFixed(1)} mb`;
}
