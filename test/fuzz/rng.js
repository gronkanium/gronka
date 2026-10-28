// Seeded so a failure prints the seed that reproduces it: FUZZ_SEED=<n> bun run test:fuzz
export const SEED = Number(process.env.FUZZ_SEED) || Date.now() % 2 ** 31;
export const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 400;

export function rng(seed = SEED) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max, min = 0) => min + Math.floor(next() * (max - min));
  const pick = list => list[int(list.length)];
  const chance = p => next() < p;
  const chars = (alphabet, max, min = 0) =>
    Array.from({ length: int(max + 1, min) }, () => pick(alphabet)).join('');
  return { next, int, pick, chance, chars };
}

export const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
export const CONTROL = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).concat('\x7f');
export const NASTY = [
  '/',
  '\\',
  '..',
  '.',
  '\0',
  '\r',
  '\n',
  '%',
  '%00',
  '%2e%2e%2f',
  '"',
  "'",
  '`',
  ';',
  '$(',
  '${',
  '|',
  '&',
  '<',
  '>',
  ' ',
  '\t',
  '‮',
  '﻿',
  '\u0085',
  ' ',
  'ｌ',
  'ⓛ',
  'ß',
  '🦆',
  '\ud800',
];

// Mixed string: printable ascii, control bytes and traversal fragments.
export function junk(r, max = 64) {
  const pieces = [];
  for (let n = r.int(max + 1); n > 0; n--) {
    const roll = r.next();
    pieces.push(roll < 0.5 ? r.pick(ASCII) : roll < 0.7 ? r.pick(CONTROL) : r.pick(NASTY));
  }
  return pieces.join('');
}

export const describeCase = (seed, i, input) =>
  `seed ${seed} iteration ${i}: ${JSON.stringify(input)}`;
