#!/usr/bin/env bun
// Fails when a public-facing file shows how this deployment works inside, or when source maps can ship.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

const PUBLIC =
  /^(README\.md|wiki\/.+\.md|\.github\/.+\.md|web\/public\/.+\.(html|js|css|json|txt|xml))$/;
const SKIP = /^web\/public\/_libav\//;

const LEAKS = [
  [/\/home\/[a-z_][\w-]*/i, 'a home directory path'],
  [
    /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
    'a private network address',
  ],
  [/\b(?:traptop|deskfart|lifeguard|ig-session|yt-session)\b/i, 'an internal host or tool name'],
  [/sourceMappingURL/, 'a source map reference'],
  [/thedorekaczynski/i, 'the personal account name'],
];

const problems = [];

for (const file of tracked) {
  if (file.endsWith('.map')) problems.push(`${file}: source maps must not be committed`);
  if (!PUBLIC.test(file) || SKIP.test(file)) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [re, what] of LEAKS) if (re.test(line)) problems.push(`${file}:${i + 1}: ${what}`);
    });
}

const DATA = /\b(?:bars?|charts?|graph|spark\w*|table|stats?|num\w*|uptime|meter)\b/i;
for (const file of tracked.filter(f => /\.(css|svelte)$/.test(f))) {
  for (const [, selector, body] of readFileSync(file, 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/filter:\s*url\(#ink/.test(body) && DATA.test(selector)) {
      problems.push(`${file}: ink filter on data (${selector.trim()}); it bends what it shows`);
    }
  }
}

for (const file of tracked.filter(f => /(^|\/)vite\.config\.[cm]?js$/.test(f))) {
  if (!/sourcemap:\s*false/.test(readFileSync(file, 'utf8')))
    problems.push(`${file}: set build.sourcemap to false`);
}
for (const file of tracked.filter(f => /(^|\/)wrangler\.toml$/.test(f))) {
  if (!/^upload_source_maps\s*=\s*false/m.test(readFileSync(file, 'utf8'))) {
    problems.push(`${file}: set upload_source_maps = false`);
  }
}

if (problems.length) {
  console.error(
    `public-facing files leak internals or ship source maps:\n  ${problems.join('\n  ')}`
  );
  process.exit(1);
}
console.log('✓ nothing internal in public-facing files, source maps off');
