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
    throw new ApiError('OFFLINE', "can't reach gronka.", 0);
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new ApiError(
      'OFFLINE',
      res.ok ? 'the connection dropped before gronka replied.' : "the file server isn't answering.",
      res.status
    );
  }
  const error = data?.error;
  if (!res.ok || error) {
    const retry = Number(error?.retryAfter ?? res.headers.get('retry-after')) || null;
    throw new ApiError(
      error?.code ?? 'INTERNAL',
      error?.message ?? 'something broke here.',
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
          "cloudflare's check didn't load. an ad blocker or strict network settings may be why.",
          0
        )
      );
    };
    document.head.append(script);
  });
  return loader;
}

// One widget per action, rendered early so a token is usually ready by submit. Turnstile fails every check
// with 600010 if anything is painted over the widget or <html> carries a data-state attribute.
const widgets = new Map();
let tsSlot;
function prepare(action) {
  if (widgets.has(action)) return widgets.get(action);
  const w = { token: null, waiters: [], id: null };
  widgets.set(action, w);
  const settle = (fn, value) => {
    for (const waiter of w.waiters.splice(0)) waiter[fn](value);
  };
  loadTurnstile().then(
    () => {
      tsSlot ??=
        document.getElementById('ts-slot') ||
        document.body.appendChild(document.createElement('div'));
      const box = document.createElement('div');
      tsSlot.append(box);
      w.id = window.turnstile.render(box, {
        sitekey: SITEKEY,
        action,
        appearance: 'interaction-only',
        'retry-interval': 800,
        'refresh-expired': 'auto',
        callback: token => {
          w.token = token;
          const waiter = w.waiters.shift();
          if (waiter) {
            w.token = null;
            window.turnstile.reset(w.id);
            waiter.resolve(token);
          }
        },
        'expired-callback': () => (w.token = null),
        'error-callback': code => {
          settle(
            'reject',
            new ApiError(
              'VERIFICATION_FAILED',
              `cloudflare couldn't check this browser (error ${code}). reload and try again.`,
              0
            )
          );
          return true; // let turnstile retry on its own for the next attempt
        },
      });
    },
    error => {
      widgets.delete(action);
      settle('reject', error);
    }
  );
  return w;
}

export const warmTurnstile = (action = 'download') => void prepare(action);

export function turnstileToken(action) {
  const w = prepare(action);
  if (w.token) {
    const token = w.token;
    w.token = null;
    window.turnstile.reset(w.id);
    return Promise.resolve(token);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    w.waiters.push(waiter);
    setTimeout(() => {
      const i = w.waiters.indexOf(waiter);
      if (i < 0) return;
      w.waiters.splice(i, 1);
      reject(
        new ApiError(
          'VERIFY_SLOW',
          "cloudflare's check is taking too long. try another network or turn off strict extensions.",
          0
        )
      );
    }, 60000);
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
