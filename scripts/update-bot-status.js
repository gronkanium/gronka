#!/usr/bin/env node
process.removeAllListeners('warning');

import { spawnSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ override: false, debug: false });

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(
    'Usage: npm run bot:status [ENV_PREFIX] [--status=online|idle|dnd|invisible] [--docker] "activity message"'
  );
  console.error('');
  console.error('Examples:');
  console.error('  npm run bot:status "hello world"');
  console.error('  npm run bot:status --status=online "Ready to process videos"');
  console.error('  npm run bot:status TEST "Testing new features"');
  console.error('  npm run bot:status PROD --status=dnd "Under maintenance"');
  console.error('  npm run bot:status --docker "Bot running in Docker"');
  console.error('');
  console.error('Options:');
  console.error('  ENV_PREFIX       Optional prefix for environment variables (TEST or PROD)');
  console.error('  --status=VALUE   Bot status (online, idle, dnd, invisible). Default: dnd');
  console.error('  --docker         Connect to bot running in Docker container');
  console.error('  activity message The message to display as bot activity');
  console.error('');
  console.error('Note: The bot must be running with its stats server for this to work.');
  console.error('      This script connects via HTTP to avoid disrupting the main bot connection.');
  process.exit(1);
}

let prefix = '';
let status = 'dnd';
let activityText = '';
let statusFlag = false;
let useDocker = false;
let prefixFound = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg.startsWith('--status=')) {
    status = arg.split('=')[1];
    statusFlag = true;
  } else if (arg === '--docker') {
    useDocker = true;
  } else if ((arg.toUpperCase() === 'TEST' || arg.toUpperCase() === 'PROD') && !prefixFound) {
    // Accept prefix anywhere before the activity text starts
    prefix = arg.toUpperCase();
    prefixFound = true;
  } else {
    if (activityText) {
      activityText += ' ';
    }
    activityText += arg;
  }
}

if (!activityText && !statusFlag) {
  console.error('Error: No activity message provided');
  console.error(
    'Usage: npm run bot:status [ENV_PREFIX] [--status=online|idle|dnd|invisible] "activity message"'
  );
  process.exit(1);
}

const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
if (!validStatuses.includes(status)) {
  console.error(`Error: Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
  process.exit(1);
}

function getEnvVar(name) {
  // Match docker-compose fallback logic: PROD_* -> TEST_* -> base
  if (prefix === 'PROD') {
    const prodName = `PROD_${name}`;
    if (process.env[prodName]) {
      return process.env[prodName];
    }
    // Fall back to TEST_ prefix (matches docker-compose behavior)
    const testName = `TEST_${name}`;
    if (process.env[testName]) {
      return process.env[testName];
    }
  } else if (prefix === 'TEST') {
    const testName = `TEST_${name}`;
    if (process.env[testName]) {
      return process.env[testName];
    }
  }
  return process.env[name];
}

// Get server configuration (check prefixed vars first, then fall back)
const SERVER_PORT = getEnvVar('SERVER_PORT') || '3000';
const SERVER_HOST = getEnvVar('SERVER_HOST') || '127.0.0.1';
const STATS_USERNAME = getEnvVar('STATS_USERNAME');
const STATS_PASSWORD = getEnvVar('STATS_PASSWORD');

// For Docker mode, we connect inside the container so always use 127.0.0.1
const DOCKER_HOST = '127.0.0.1';

const url = `http://${SERVER_HOST}:${SERVER_PORT}/api/bot/status`;

// Build request body
const body = {};
if (status) body.status = status;
if (activityText) body.activity = activityText;

// Build headers
const headers = {
  'Content-Type': 'application/json',
};

// Add basic auth if credentials are configured
if (STATS_USERNAME && STATS_PASSWORD) {
  const credentials = Buffer.from(`${STATS_USERNAME}:${STATS_PASSWORD}`).toString('base64');
  headers['Authorization'] = `Basic ${credentials}`;
}

// Docker mode: use docker exec to run node fetch inside the container
if (useDocker) {
  const containerName = 'gronka';
  const dockerUrl = `http://${DOCKER_HOST}:${SERVER_PORT}/api/bot/status`;

  // Build headers object for the script
  const scriptHeaders = { 'Content-Type': 'application/json' };
  if (STATS_USERNAME && STATS_PASSWORD) {
    const creds = Buffer.from(`${STATS_USERNAME}:${STATS_PASSWORD}`).toString('base64');
    scriptHeaders['Authorization'] = `Basic ${creds}`;
  }

  // Inline Node.js script - using template that will have values injected
  const nodeScript = `
const h=${JSON.stringify(scriptHeaders)};
const b=${JSON.stringify(body)};
fetch("${dockerUrl}",{method:"POST",headers:h,body:JSON.stringify(b)})
.then(r=>r.json().then(d=>({ok:r.ok,data:d})))
.then(({ok,data})=>{
if(!ok){console.error(JSON.stringify({error:data.error||"fail"}));process.exit(1)}
console.log(JSON.stringify(data))})
.catch(e=>{console.error(JSON.stringify({error:e.message,cause:e.cause?.code||e.cause?.message||null}));process.exit(1)})
`.replace(/\n/g, '');

  console.log(`Updating bot status via Docker (${containerName}) -> ${dockerUrl}`);

  const result = spawnSync('docker', ['exec', containerName, 'node', '-e', nodeScript], {
    encoding: 'utf-8',
  });

  if (result.error) {
    console.error('Error:', result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    if (result.stderr?.includes('No such container')) {
      console.error(`Error: Docker container '${containerName}' is not running`);
      console.error('Start it with: npm run docker:up');
    } else if (result.stderr) {
      try {
        const errData = JSON.parse(result.stderr.trim());
        if (errData.cause) {
          console.error(`Error: ${errData.error} (${errData.cause})`);
        } else {
          console.error(`Error: ${errData.error}`);
        }
      } catch {
        console.error('Error:', result.stderr.trim());
      }
    } else {
      console.error('Error: Command failed');
    }
    process.exit(1);
  }

  try {
    const data = JSON.parse(result.stdout.trim());

    if (data.error) {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }

    console.log(`Logged in as ${data.botTag}`);
    const statusMsg = data.activity
      ? `Status updated to "${data.status}" with activity: "${data.activity}"`
      : `Status updated to "${data.status}"`;
    console.log(statusMsg);
    process.exit(0);
  } catch {
    console.error('Error: Failed to parse response');
    console.error(result.stdout);
    process.exit(1);
  }
} else {
  // Direct HTTP mode
  console.log(`Updating bot status via ${url}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        console.error('Error: Authentication failed. Check STATS_USERNAME and STATS_PASSWORD.');
      } else if (response.status === 503) {
        console.error('Error: Bot is not ready yet. Wait for it to connect to Discord.');
      } else {
        console.error(`Error: ${data.error || 'Unknown error'}`);
      }
      process.exit(1);
    }

    console.log(`Logged in as ${data.botTag}`);
    const statusMsg = data.activity
      ? `Status updated to "${data.status}" with activity: "${data.activity}"`
      : `Status updated to "${data.status}"`;
    console.log(statusMsg);
    process.exit(0);
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.error(`Error: Could not connect to bot at ${url}`);
      console.error('Make sure the bot is running (npm run bot:test or npm run bot:prod)');
      console.error('If the bot is in Docker, use --docker flag');
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}
