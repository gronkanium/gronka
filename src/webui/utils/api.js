export const getJson = url =>
  fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

export const getJsonOrNull = url => getJson(url).catch(() => null);

export const sendJson = (url, method, body) =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
