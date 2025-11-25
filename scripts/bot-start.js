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
const withWebui = process.argv.includes('--with-webui');

if (!prefix || !['TEST', 'PROD'].includes(prefix)) {
  console.error('usage: node scripts/bot-start.js [TEST|PROD] [--with-webui]');
  console.error('  starts the bot using TEST_* or PROD_* prefixed environment variables');
  console.error('  --with-webui: also starts the main server and webui server');
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
  'SERVER_PORT',
  'WEBUI_PORT',
  'WEBUI_HOST',
  'STATS_USERNAME',
  'STATS_PASSWORD',
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
  // Derive database path from storage path or use default with prefix
  const storagePath = env.GIF_STORAGE_PATH || './data';
  const dbFileName = `gronka-${prefix.toLowerCase()}.db`;
  env.GRONKA_DB_PATH = path.join(storagePath, dbFileName);
}

// Set defaults for server and webui if not provided
if (withWebui) {
  // Server defaults
  if (!env.SERVER_PORT) {
    env.SERVER_PORT = '3000';
  }
  
  // WebUI defaults
  if (!env.WEBUI_PORT) {
    env.WEBUI_PORT = '3001';
  }
  if (!env.WEBUI_HOST) {
    env.WEBUI_HOST = '127.0.0.1';
  }
  
  // Main server URL for webui (derived from SERVER_PORT)
  env.MAIN_SERVER_URL = `http://localhost:${env.SERVER_PORT}`;
}

// Store processes for cleanup
const processes = [];

// Function to start a process
function startProcess(name, scriptPath, options = {}) {
  const proc = spawn('node', [scriptPath], {
    env: { ...env, ...options.env },
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
    ...options,
  });

  proc.on('error', error => {
    console.error(`failed to start ${name}: ${error.message}`);
    cleanup();
    process.exit(1);
  });

  processes.push({ name, process: proc });
  return proc;
}

// Function to cleanup all processes
function cleanup() {
  console.log('\nshutting down processes...');
  for (const { name, process: proc } of processes) {
    try {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      }
    } catch (error) {
      console.error(`error killing ${name}:`, error.message);
    }
  }
}

if (withWebui) {
  console.log('starting services with webui...\n');
  
  // Start main server first (webui depends on it)
  const serverPath = join(__dirname, '..', 'src', 'server.js');
  console.log(`starting server on port ${env.SERVER_PORT}...`);
  startProcess('server', serverPath);
  
  // Wait a moment for server to start before starting webui
  setTimeout(() => {
    // Start webui server
    const webuiPath = join(__dirname, '..', 'src', 'webui-server.js');
    console.log(`starting webui on ${env.WEBUI_HOST}:${env.WEBUI_PORT}...`);
    startProcess('webui', webuiPath);
    
    // Wait a moment for webui to start before starting bot
    setTimeout(() => {
      // Start bot
      const botPath = join(__dirname, '..', 'src', 'bot.js');
      console.log('starting bot...\n');
      startProcess('bot', botPath);
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('all services started');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`  server: http://localhost:${env.SERVER_PORT}`);
      console.log(`  webui:  http://${env.WEBUI_HOST}:${env.WEBUI_PORT}`);
      console.log(`  bot:    running (${prefix} mode)`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }, 1000);
  }, 2000);
} else {
  // Start only the bot
  const botPath = join(__dirname, '..', 'src', 'bot.js');
  startProcess('bot', botPath);
}

// Handle termination signals
process.on('SIGINT', () => {
  cleanup();
  // Give processes time to shutdown gracefully
  setTimeout(() => {
    process.exit(0);
  }, 2000);
});

process.on('SIGTERM', () => {
  cleanup();
  // Give processes time to shutdown gracefully
  setTimeout(() => {
    process.exit(0);
  }, 2000);
});
