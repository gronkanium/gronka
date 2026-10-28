import { test, describe, expect } from 'bun:test';
import { validateUrl, blockedAddressReason, rateLimitAddress } from '../../src/utils/validation.js';
import { readLink, prepareLink } from '../../src/core/intake.js';
import { hostOf } from '../../src/utils/url-host.js';
import { rng, junk, SEED, ITERATIONS, describeCase } from './rng.js';

// Independent model of what must never be reachable, written from the RFCs, not from validation.js.
function privateV4(n) {
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  const c = (n >>> 8) & 255;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(g) {
  const zero5 = g.slice(0, 5).every(x => x === 0);
  const v4 = (hi, lo) => ((hi << 16) | lo) >>> 0;
  if (g.every(x => x === 0)) return true;
  if (zero5 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
  if (zero5 && g[5] === 0xffff) return privateV4(v4(g[6], g[7]));
  if (zero5 && g[5] === 0) return privateV4(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0)
    return privateV4(v4(g[6], g[7]));
  if (g[0] === 0x2002) return privateV4(v4(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

const PRIVATE_V4_SEEDS = [
  [0, 0, 0, 0],
  [10, 0, 0, 1],
  [100, 64, 0, 1],
  [127, 0, 0, 1],
  [127, 255, 255, 254],
  [169, 254, 169, 254],
  [172, 16, 0, 1],
  [172, 31, 255, 255],
  [192, 0, 0, 1],
  [192, 168, 1, 1],
  [198, 18, 0, 1],
  [224, 0, 0, 1],
  [255, 255, 255, 255],
];

function randomV4(r) {
  if (r.chance(0.5)) {
    const base = r.pick(PRIVATE_V4_SEEDS);
    return base.map((o, i) => (i === 0 ? o : r.chance(0.5) ? o : r.int(256)));
  }
  return [r.int(256), r.int(256), r.int(256), r.int(256)];
}

const toInt = octets =>
  ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;

// Every spelling the WHATWG parser maps back to the same address.
function numeral(r, value) {
  const style = r.pick(['dec', 'hex', 'oct']);
  if (style === 'hex') return `0${r.pick(['x', 'X'])}${value.toString(16)}`;
  if (style === 'oct') return `0${value.toString(8)}`;
  return String(value);
}

function spellV4(r, octets) {
  const parts = r.int(5, 1);
  const head = octets.slice(0, parts - 1);
  const tailBytes = octets.slice(parts - 1);
  const tail = tailBytes.reduce((acc, o) => acc * 256 + o, 0);
  const pieces = [...head.map(o => numeral(r, o)), numeral(r, tail)];
  return pieces.join('.') + (r.chance(0.15) ? '.' : '');
}

function hex(g) {
  return g.toString(16);
}

function spellV6(r, groups) {
  const upper = r.chance(0.3);
  let text;
  const style = r.pick(['full', 'compressed', 'dotted']);
  if (style === 'dotted' && groups.slice(0, 5).every(x => x === 0)) {
    const v4 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    text = `::${groups[5] ? hex(groups[5]) + ':' : ''}${v4}`;
  } else if (style === 'compressed') {
    let best = { at: -1, len: 0 };
    for (let i = 0; i < 8; i++) {
      let len = 0;
      while (i + len < 8 && groups[i + len] === 0) len++;
      if (len > best.len) best = { at: i, len };
      i += len;
    }
    if (best.len < 2) text = groups.map(hex).join(':');
    else
      text = `${groups.slice(0, best.at).map(hex).join(':')}::${groups
        .slice(best.at + best.len)
        .map(hex)
        .join(':')}`;
  } else {
    text = groups.map(g => hex(g).padStart(r.chance(0.5) ? 4 : 1, '0')).join(':');
  }
  return upper ? text.toUpperCase() : text;
}

function randomV6(r) {
  const kind = r.pick([
    'global',
    'mapped',
    'compat',
    'nat64',
    '6to4',
    'ula',
    'link',
    'site',
    'teredo',
    'multicast',
    'loop',
    'any',
  ]);
  const v4 = randomV4(r);
  const hi = (v4[0] << 8) | v4[1];
  const lo = (v4[2] << 8) | v4[3];
  const rand = () => r.int(0x10000);
  switch (kind) {
    case 'mapped':
      return [0, 0, 0, 0, 0, 0xffff, hi, lo];
    case 'compat':
      return [0, 0, 0, 0, 0, 0, hi, lo];
    case 'nat64':
      return [0x64, 0xff9b, 0, 0, 0, 0, hi, lo];
    case '6to4':
      return [0x2002, hi, lo, rand(), rand(), rand(), rand(), rand()];
    case 'ula':
      return [0xfc00 | r.int(0x200), rand(), rand(), rand(), rand(), rand(), rand(), rand()];
    case 'link':
      return [0xfe80 | r.int(0x40), rand(), rand(), rand(), rand(), rand(), rand(), rand()];
    case 'site':
      return [0xfec0 | r.int(0x40), rand(), rand(), rand(), rand(), rand(), rand(), rand()];
    case 'teredo':
      return [0x2001, 0, rand(), rand(), rand(), rand(), rand(), rand()];
    case 'multicast':
      return [0xff00 | r.int(0x100), rand(), rand(), rand(), rand(), rand(), rand(), rand()];
    case 'loop':
      return [0, 0, 0, 0, 0, 0, 0, r.int(2)];
    case 'any':
      return Array.from({ length: 8 }, rand);
    default:
      return [0x2000 | r.int(0x1fff), rand(), rand(), rand(), rand(), rand(), rand(), rand()];
  }
}

const LOOPBACK_NAMES = ['localhost', 'ip6-localhost', 'ip6-loopback'];
const FULLWIDTH = s => s.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 97 + 0xff41));
const CIRCLED = s => s.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 97 + 0x24d0));

function spellLoopbackName(r) {
  let name = r.pick(LOOPBACK_NAMES);
  if (r.chance(0.3)) name = `${r.chars('abcxyz0123456789-'.split(''), 12, 1)}.localhost`;
  const mapper = r.pick([s => s, s => s.toUpperCase(), FULLWIDTH, CIRCLED]);
  name = mapper(name);
  return name + (r.chance(0.3) ? '.' : '');
}

const WS = ['', '', ' ', '\t', '\n', '\r', ' \t'];

function wrap(r, host) {
  const scheme = r.pick(['http', 'https', 'HTTP', 'Http', 'hTTPs']);
  const user = r.chance(0.2) ? `${r.chars('ab1.:@'.split(''), 8)}@` : '';
  const port = r.chance(0.3) ? `:${r.int(65536)}` : '';
  const path = r.chance(0.6) ? `/${r.chars('abc/%2.?=&#'.split(''), 20)}` : '';
  return `${r.pick(WS)}${scheme}://${user}${host}${port}${path}${r.pick(WS)}`;
}

describe('ssrf fuzz', () => {
  test(`private IPv4 in every numeric spelling is refused (seed ${SEED})`, () => {
    const r = rng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const octets = randomV4(r);
      const url = wrap(r, spellV4(r, octets));
      let parsed;
      try {
        parsed = new URL(url).hostname;
      } catch {
        continue;
      }
      const expected = privateV4(toInt(octets));
      const actual = !validateUrl(url).valid;
      expect([describeCase(SEED, i, { url, parsed }), actual]).toEqual([
        describeCase(SEED, i, { url, parsed }),
        expected,
      ]);
    }
  });

  test(`IPv6 literals agree with the RFC model (seed ${SEED})`, () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const groups = randomV6(r);
      const url = wrap(r, `[${spellV6(r, groups)}]`);
      let parsed;
      try {
        parsed = new URL(url).hostname;
      } catch {
        continue;
      }
      const expected = privateV6(groups);
      const actual = !validateUrl(url).valid;
      expect([describeCase(SEED, i, { url, parsed }), actual]).toEqual([
        describeCase(SEED, i, { url, parsed }),
        expected,
      ]);
    }
  });

  test(`loopback names in any case, width or trailing dot are refused (seed ${SEED})`, () => {
    const r = rng(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const url = wrap(r, spellLoopbackName(r));
      let parsed;
      try {
        parsed = new URL(url).hostname;
      } catch {
        continue;
      }
      expect([describeCase(SEED, i, { url, parsed }), validateUrl(url).valid]).toEqual([
        describeCase(SEED, i, { url, parsed }),
        false,
      ]);
    }
  });

  test(`a zone id, userinfo or port never smuggles a private host past the guard (seed ${SEED})`, () => {
    const r = rng(SEED + 3);
    for (let i = 0; i < ITERATIONS; i++) {
      const inner = r.pick(['127.0.0.1', '[::1]', 'localhost', '10.0.0.1', '[fe80::1]']);
      const host = r.pick([
        `${inner}%25eth0`,
        `[fe80::1%25${r.chars('abc0'.split(''), 5)}]`,
        `${inner}:80@203.0.113.1`,
        `203.0.113.1@${inner}`,
        `${inner}#@203.0.113.1`,
        `${inner}\\@203.0.113.1`,
        `${inner}%00.example.com`,
        `${inner}。example.com`,
      ]);
      const url = wrap(r, host);
      let hostname;
      try {
        hostname = new URL(url).hostname;
      } catch {
        continue;
      }
      const stripped = hostname.replace(/^\[|\]$/g, '');
      const inwardHost = !!blockedAddressReason(stripped) || /(^|\.)localhost\.?$/.test(hostname);
      if (inwardHost) {
        expect([describeCase(SEED, i, { url, hostname }), validateUrl(url).valid]).toEqual([
          describeCase(SEED, i, { url, hostname }),
          false,
        ]);
      }
    }
  });

  test(`anything validateUrl accepts is an http(s) link that cannot be read as a flag (seed ${SEED})`, () => {
    const r = rng(SEED + 4);
    for (let i = 0; i < ITERATIONS; i++) {
      const url = r.chance(0.5) ? junk(r, 80) : wrap(r, junk(r, 30));
      let verdict;
      expect(() => (verdict = validateUrl(url))).not.toThrow();
      if (!verdict.valid) continue;
      // eslint-disable-next-line no-control-regex
      expect([describeCase(SEED, i, url), /^[\s\x00-\x20]*https?:\/\//i.test(url)]).toEqual([
        describeCase(SEED, i, url),
        true,
      ]);
    }
  });

  test(`readLink and prepareLink never throw and never widen what validateUrl allows (seed ${SEED})`, async () => {
    const r = rng(SEED + 5);
    for (let i = 0; i < ITERATIONS; i++) {
      const text = r.chance(0.5)
        ? junk(r, 120)
        : `${junk(r, 10)} ${wrap(r, r.chance(0.5) ? spellV4(r, randomV4(r)) : `${r.chars('abc-'.split(''), 10, 1)}.example`)} ${junk(r, 10)}`;
      let read;
      try {
        read = readLink(text);
      } catch (error) {
        throw new Error(`readLink threw on ${describeCase(SEED, i, text)}: ${error.message}`, {
          cause: error,
        });
      }
      if (read.refusal) {
        expect(typeof read.refusal.message).toBe('string');
        continue;
      }
      expect([describeCase(SEED, i, text), validateUrl(read.url).valid]).toEqual([
        describeCase(SEED, i, text),
        true,
      ]);
      // Short-link hosts would go to the network; everything else canonicalizes offline.
      if (
        [
          'share.google',
          'vm.tiktok.com',
          'vt.tiktok.com',
          'b23.tv',
          'tiktok.com',
          'facebook.com',
          'm.facebook.com',
        ].includes(hostOf(read.url))
      )
        continue;
      const prepared = await prepareLink(read.url);
      expect([describeCase(SEED, i, text), validateUrl(prepared).valid]).toEqual([
        describeCase(SEED, i, text),
        true,
      ]);
    }
  });

  test(`rateLimitAddress never throws and folds a /64 onto one key (seed ${SEED})`, () => {
    const r = rng(SEED + 6);
    for (let i = 0; i < ITERATIONS; i++) {
      const groups = randomV6(r);
      const sibling = [
        ...groups.slice(0, 4),
        r.int(0x10000),
        r.int(0x10000),
        r.int(0x10000),
        r.int(0x10000),
      ];
      const a = spellV6(r, groups);
      const b = spellV6(r, sibling);
      // An embedded IPv4 (mapped, compat, NAT64, 6to4) keys on that address, not on the /64.
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(rateLimitAddress(a))) {
        expect([describeCase(SEED, i, { a, b }), rateLimitAddress(a)]).toEqual([
          describeCase(SEED, i, { a, b }),
          rateLimitAddress(b),
        ]);
      }
      expect(() => rateLimitAddress(junk(r, 60))).not.toThrow();
      expect(typeof rateLimitAddress(junk(r, 60))).toBe('string');
    }
  });
});
