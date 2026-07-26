#!/usr/bin/env bun
/**
 * Runs the e2e suite with one Bun process per test file.
 *
 * Why this exists: `node --test` forked a process per file, so each e2e file got a clean module
 * registry. `bun test` runs every file in ONE process, and mock.module() is process-global and
 * only affects importers that resolve AFTER it is registered. Put both e2e files in one process
 * and download-e2e.test.js (which imports the real child_process chain via download.js ->
 * ytdlp.js) permanently binds the real spawn before ytdlp-retry-e2e.test.js can mock it - five
 * tests fail for reasons that have nothing to do with the code under test.
 *
 * Spawning per file restores the isolation the mocks assume. It also closes a `bun test`
 * footgun: a filter that matches no files exits 0, so a typo'd path would silently "pass".
 * Here, zero discovered files is a hard failure.
 */
import { spawnSync } from 'child_process';
import { globSync } from 'fs';

const files = globSync('test/**/*-e2e.test.js').sort();

if (files.length === 0) {
  console.error('run-e2e-tests: no files matched test/**/*-e2e.test.js');
  process.exit(1);
}

console.log(`running ${files.length} e2e file(s), one process each`);

const failed = [];
for (const file of files) {
  console.log(`\n--- ${file} ---`);
  // --timeout matches the unit script: bun defaults to 5s per test where node:test had no
  // limit, and the download pipeline tests do real disk and Postgres work.
  const result = spawnSync('bun', ['test', file, '--timeout', '30000'], {
    stdio: 'inherit',
    // Inherited from the npm script; GRONKA_E2E is what un-skips the module-mock suites.
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) failed.push(file);
}

if (failed.length > 0) {
  console.error(`\ne2e failed in ${failed.length} file(s):`);
  for (const file of failed) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`\nall ${files.length} e2e file(s) passed`);
