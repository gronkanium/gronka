import net from 'net';
import { fetchPage } from './ssrf-guard.js';

const RELAYS_URL = 'https://api.mullvad.net/www/relays/wireguard/';
const RELAYS_TTL_MS = 24 * 60 * 60 * 1000;
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
let relays = null;
const norm = name =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

async function mullvadRelays() {
  if (relays && Date.now() - relays.at < RELAYS_TTL_MS) return relays.list;
  const { data } = await fetchPage(RELAYS_URL, {
    failMessage: 'the vpn relay list is unavailable',
    responseType: 'json',
  });
  relays = { at: Date.now(), list: Array.isArray(data) ? data : [] };
  return relays.list;
}

// yt-dlp names countries in English; Mullvad and Intl spell a few differently (Czech Republic, Czechia).
export async function exitRelay(countries) {
  const wanted = new Set(countries.map(norm));
  const fits = (await mullvadRelays()).filter(
    relay =>
      relay.active &&
      relay.socks_name &&
      (wanted.has(norm(relay.country_name)) ||
        wanted.has(norm(regionName.of(relay.country_code.toUpperCase()))))
  );
  const relay = fits[Math.floor(Math.random() * fits.length)];
  return relay
    ? { host: relay.socks_name, port: relay.socks_port ?? 1080, country: relay.country_name }
    : null;
}

// Mullvad's per-relay SOCKS5 is only reachable inside the tunnel, so each connection is
// CONNECTed through the vpn's http proxy and yt-dlp speaks SOCKS5 to the relay itself.
export async function relayForwarder(relay, proxyUrl) {
  const proxy = new URL(proxyUrl);
  const target = `${relay.host}:${relay.port}`;
  const server = net.createServer(client => {
    client.pause();
    const upstream = net.connect(Number(proxy.port) || 80, proxy.hostname);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
    upstream.on('connect', () =>
      upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    );
    let head = Buffer.alloc(0);
    const onHead = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      upstream.off('data', onHead);
      if (!/^HTTP\/1\.[01] 200/.test(head.toString('latin1'))) return close();
      if (head.length > end + 4) client.write(head.subarray(end + 4));
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on('data', onHead);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `socks5h://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}
