#!/usr/bin/env node
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(
    'Usage: npm run bot:status [ENV_PREFIX] [--status=online|idle|dnd|invisible] "activity message"'
  );
  console.error('');
  console.error('Examples:');
  console.error('  npm run bot:status "hello world"');
  console.error('  npm run bot:status --status=online "Ready to process videos"');
  console.error('  npm run bot:status TEST "Testing new features"');
  console.error('  npm run bot:status PROD --status=dnd "Under maintenance"');
  console.error('');
  console.error('Options:');
  console.error('  ENV_PREFIX       Optional prefix for environment variables (TEST or PROD)');
  console.error('  --status=VALUE   Bot status (online, idle, dnd, invisible). Default: dnd');
  console.error('  activity message The message to display as bot activity');
  process.exit(1);
}

let prefix = '';
let status = 'dnd';
let activityText = '';
let statusFlag = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg.startsWith('--status=')) {
    status = arg.split('=')[1];
    statusFlag = true;
  } else if ((arg === 'TEST' || arg === 'PROD') && i === 0) {
    prefix = arg;
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
  if (prefix) {
    const prefixedName = `${prefix}_${name}`;
    if (process.env[prefixedName]) {
      return process.env[prefixedName];
    }
  }
  return process.env[name];
}

const DISCORD_TOKEN = getEnvVar('DISCORD_TOKEN');

if (!DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN not found in environment');
  if (prefix) {
    console.error(`Looked for: ${prefix}_DISCORD_TOKEN and DISCORD_TOKEN`);
  }
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const presenceOptions = { status };

    if (activityText) {
      presenceOptions.activities = [
        {
          name: activityText,
          type: ActivityType.Custom,
        },
      ];
    }

    await readyClient.user.setPresence(presenceOptions);

    const statusMsg = activityText
      ? `Status updated to "${status}" with activity: "${activityText}"`
      : `Status updated to "${status}"`;
    console.log(statusMsg);

    setTimeout(() => {
      console.log('Logging out...');
      client.destroy();
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error('Error updating status:', error);
    client.destroy();
    process.exit(1);
  }
});

client.on('error', error => {
  console.error('Discord client error:', error);
  process.exit(1);
});

console.log('Logging in to Discord...');
client.login(DISCORD_TOKEN);

setTimeout(() => {
  console.error('Timeout: Failed to connect to Discord within 30 seconds');
  client.destroy();
  process.exit(1);
}, 30000);
