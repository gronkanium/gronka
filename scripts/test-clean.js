#!/usr/bin/env node

/**
 * Test runner that filters out verbose FFmpeg logs
 * Usage: node scripts/test-clean.js [test files...]
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Patterns to filter out (FFmpeg verbose output)
const FILTER_PATTERNS = [
  // FFmpeg version and build info (multi-line blocks)
  /^ffmpeg version \d+\.\d+\.\d+.*$/m,
  /^ {2}built with .*$/m,
  /^ {2}configuration: .*$/m,
  /^ {2}libavutil\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libavcodec\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libavformat\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libavdevice\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libavfilter\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libswscale\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  /^ {2}libswresample\s+\d+\.\s+\d+\.\d+\s+\/.*$/m,
  // FFmpeg format detection warnings
  /^\[.*@ [0-9a-f]+\] Format .* detected only with low score.*$/m,
  /^\[.*@ [0-9a-f]+\] moov atom not found.*$/m,
  /^\[in#\d+ @ [0-9a-f]+\] Error opening input:.*$/m,
  // Duplicate error messages
  /^Error opening input file .*\. Error opening input files:.*$/m,
];

// Patterns to keep (important errors and test output)
const KEEP_PATTERNS = [
  /^✔|^✖|^ℹ/, // Test results
  /^# tests|^# suites|^# pass|^# fail|^# cancelled|^# skipped|^# todo|^# duration/, // Test summary
  /^failing tests:/, // Failure section
  /^Error:|^AssertionError/, // Important errors
  /^\[.*\] \[ERROR\] (?!FFmpeg (pass \d+|video trim|GIF trim) failed:).*$/, // Non-FFmpeg errors
  /^\[.*\] \[INFO\].*$/, // Info messages
  /^Subtest:/, // Test structure
  /^ok \d+|^not ok \d+/, // Test results
];

function shouldFilterLine(line) {
  // Filter out FFmpeg error lines that contain embedded newlines
  if (/\[ERROR\] FFmpeg (pass \d+|video trim|GIF trim) failed:.*ffmpeg version/.test(line)) {
    return true;
  }
  const trimmed = line.trim();

  // Skip empty lines
  if (!trimmed) {
    return false; // Keep empty lines for readability
  }

  // Always keep test results and summaries
  if (KEEP_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return false;
  }

  // Filter out verbose FFmpeg output
  if (FILTER_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return true;
  }

  // Keep everything else
  return false;
}

let buffer = '';
let inFFmpegBlock = false;

function processOutput(data) {
  buffer += data.toString();
  const lines = buffer.split('\n');

  // Keep the last incomplete line in buffer
  buffer = lines.pop() || '';

  const filtered = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of FFmpeg error block
    if (/^\[.*\] \[ERROR\] FFmpeg (pass \d+|video trim|GIF trim) failed:/.test(trimmed)) {
      inFFmpegBlock = true;
      // Skip the header line
      continue;
    }

    // Detect end of FFmpeg error block (empty line or non-FFmpeg content)
    if (inFFmpegBlock) {
      if (!trimmed || !FILTER_PATTERNS.some(p => p.test(trimmed))) {
        inFFmpegBlock = false;
        // Don't output the line that ended the block if it's empty
        if (trimmed) {
          filtered.push(line);
        }
        continue;
      }
      // Skip lines within FFmpeg block
      continue;
    }

    // Normal filtering for non-FFmpeg blocks
    if (!shouldFilterLine(line)) {
      filtered.push(line);
    }
  }

  if (filtered.length > 0) {
    process.stdout.write(filtered.join('\n') + '\n');
  }
}

// Get test files from command line args, or default to test/
const testFiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test/'];

// Set up environment variables
const env = {
  ...process.env,
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
};

// Spawn the test process
const testProcess = spawn('node', ['--test', ...testFiles], {
  cwd: projectRoot,
  env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

// Process stdout and stderr
testProcess.stdout.on('data', processOutput);
testProcess.stderr.on('data', processOutput);

// Forward exit code
testProcess.on('close', code => {
  // Flush any remaining buffer
  if (buffer) {
    const lines = buffer.split('\n');
    const filtered = lines.filter(line => !shouldFilterLine(line));
    if (filtered.length > 0) {
      process.stdout.write(filtered.join('\n') + '\n');
    }
  }
  process.exit(code || 0);
});

testProcess.on('error', error => {
  console.error('Failed to start test process:', error);
  process.exit(1);
});
