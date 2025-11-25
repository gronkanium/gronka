#!/usr/bin/env node

import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

// Get prefix from command line argument (TEST or PROD)
const prefix = process.argv[2]?.toUpperCase();

if (!prefix || !['TEST', 'PROD'].includes(prefix)) {
  console.error('usage: node scripts/bot-start.js [TEST|PROD]');
  console.error('  starts the bot using TEST_* or PROD_* prefixed environment variables');
  process.exit(1);
}

// Map prefixed env vars to standard names for the bot
const envPrefix = `${prefix}_`;
const env = { ...process.env };

// Get prefixed values
const tokenKey = `${envPrefix}DISCORD_TOKEN`;
const clientIdKey = `${envPrefix}CLIENT_ID`;

const token = env[tokenKey];
const clientId = env[clientIdKey];

if (!token) {
  console.error(`error: ${tokenKey} is not set in environment variables`);
  process.exit(1);
}

if (!clientId) {
  console.error(`error: ${clientIdKey} is not set in environment variables`);
  process.exit(1);
}

// Set standard env vars that bot.js expects
env.DISCORD_TOKEN = token;
env.CLIENT_ID = clientId;

// Also map other prefixed vars if they exist
const prefixMappings = [
  'ADMIN_USER_IDS',
  'CDN_BASE_URL',
  'GIF_STORAGE_PATH',
  'MAX_GIF_WIDTH',
  'MAX_GIF_DURATION',
  'DEFAULT_FPS',
  'COBALT_API_URL',
  'COBALT_ENABLED',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_DOMAIN',
  'NTFY_TOPIC',
  'LOG_LEVEL',
  'LOG_DIR',
];

for (const key of prefixMappings) {
  const prefixedKey = `${envPrefix}${key}`;
  if (env[prefixedKey] !== undefined) {
    env[key] = env[prefixedKey];
  }
}

// For local dev, override COBALT_API_URL to use localhost
if (!env.COBALT_API_URL || env.COBALT_API_URL.includes('cobalt:9000')) {
  env.COBALT_API_URL = 'http://localhost:9000';
}

// Set separate database path for test/prod bots
// If GRONKA_DB_PATH is explicitly set via prefix, use it
// Otherwise, derive it from GIF_STORAGE_PATH or use default with prefix
const dbPathKey = `${envPrefix}GRONKA_DB_PATH`;
if (env[dbPathKey]) {
  env.GRONKA_DB_PATH = env[dbPathKey];
} else {
  // Derive database path from storage path or use default
  const storagePath = env.GIF_STORAGE_PATH || './data';
  const dbFileName = `gronka-${prefix.toLowerCase()}.db`;
  env.GRONKA_DB_PATH = path.join(storagePath, dbFileName);
}

// Start the bot
const botPath = join(__dirname, '..', 'src', 'bot.js');
const botProcess = spawn('node', [botPath], {
  env,
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});

botProcess.on('error', error => {
  console.error(`failed to start bot: ${error.message}`);
  process.exit(1);
});

botProcess.on('exit', code => {
  process.exit(code || 0);
});

// Handle termination signals
process.on('SIGINT', () => {
  botProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  botProcess.kill('SIGTERM');
});
