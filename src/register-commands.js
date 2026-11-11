import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { OUTPUT_FORMATS } from './utils/output-formats.js';

// Define the commands
export const commands = [
  {
    name: 'convert',
    type: 3, // MESSAGE type (right-click on message)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'download',
    type: 3, // MESSAGE type (right-click on message)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'optimize',
    type: 3, // MESSAGE type (right-click on message)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'convert',
    description: 'convert video, audio or images: choose a compatible output format',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'file',
        description: 'the video, audio or image file to convert',
        type: 11, // ATTACHMENT type
        file_types: ['video', 'audio', 'image'],
        required: false,
      },
      {
        name: 'link',
        description: 'link to the media to download and convert',
        type: 3, // STRING type
        required: false,
      },
      {
        name: 'format',
        description: 'output format. leave blank to choose from compatible formats',
        type: 3, // STRING type
        required: false,
        choices: [
          { name: 'GIF', value: 'gif' },
          ...Object.entries(OUTPUT_FORMATS).map(([value, { label }]) => ({ name: label, value })),
        ],
      },
      {
        name: 'optimize',
        description: 'GIF output only: optimize after conversion to reduce file size',
        type: 5, // BOOLEAN type
        required: false,
      },
      {
        name: 'lossy',
        description:
          'GIF output only: lossy compression (0-100, default: 35). higher = smaller, lower quality',
        type: 10, // NUMBER type
        required: false,
        min_value: 0,
        max_value: 100,
      },
      {
        name: 'start',
        description:
          'start time for video, audio or animation, in seconds or as a timestamp (e.g. 90 or 1:30)',
        type: 3, // STRING type (accepts seconds or MM:SS / HH:MM:SS timestamps)
        required: false,
      },
      {
        name: 'end',
        description:
          'end time for video, audio or animation, in seconds or as a timestamp (e.g. 90 or 1:30)',
        type: 3, // STRING type (accepts seconds or MM:SS / HH:MM:SS timestamps)
        required: false,
      },
    ],
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'optimize',
    description: 'optimize a gif to reduce its file size',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'file',
        description: 'the gif file to optimize',
        type: 11, // ATTACHMENT type
        required: false,
        file_types: ['.gif'],
      },
      {
        name: 'link',
        description: 'link to a gif to optimize',
        type: 3, // STRING type
        required: false,
      },
      {
        name: 'lossy',
        description:
          'lossy compression level (0-100, default: 35). higher = more compression, lower quality',
        type: 10, // NUMBER type
        required: false,
        min_value: 0,
        max_value: 100,
      },
    ],
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'download',
    description: 'download a video or image from a social media url (no conversion)',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'link',
        description: 'link to a social media post or media file to download',
        type: 3, // STRING type
        required: true,
      },
      {
        name: 'start',
        description:
          'start time for video trimming, in seconds or as a timestamp (e.g. 90 or 1:30)',
        type: 3, // STRING type (accepts seconds or MM:SS / HH:MM:SS timestamps)
        required: false,
      },
      {
        name: 'end',
        description: 'end time for video trimming, in seconds or as a timestamp (e.g. 90 or 1:30)',
        type: 3, // STRING type (accepts seconds or MM:SS / HH:MM:SS timestamps)
        required: false,
      },
    ],
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'info',
    description: 'bot version, memory, uptime and queue status',
    type: 1, // CHAT_INPUT type (slash command)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
];

// Replaces the application's global commands with this list; returns what Discord stored.
export function registerCommands(token, clientId) {
  return new REST({ version: '10' })
    .setToken(token)
    .put(Routes.applicationCommands(clientId), { body: commands });
}

export function registerErrorHint(error) {
  if (error.code === 50001)
    return 'missing access: the bot does not have permission to register commands';
  if (error.code === 50035) return 'invalid form body: command structure is invalid';
  if (error.status === 401) return 'unauthorized: invalid bot token';
  return null;
}

if (import.meta.main) {
  // Load environment variables
  dotenv.config({ quiet: true });

  // Get prefix from command line argument (TEST or PROD) or use default
  const prefixArg = process.argv[2]?.toUpperCase();
  const usePrefix = prefixArg && ['TEST', 'PROD'].includes(prefixArg);

  // Get token and client ID based on prefix
  let DISCORD_TOKEN, CLIENT_ID;

  if (usePrefix) {
    const envPrefix = `${prefixArg}_`;
    DISCORD_TOKEN = process.env[`${envPrefix}DISCORD_TOKEN`];
    CLIENT_ID = process.env[`${envPrefix}CLIENT_ID`];
  } else {
    // Default behavior: use standard env vars
    DISCORD_TOKEN = process.env.DISCORD_TOKEN;
    CLIENT_ID = process.env.CLIENT_ID;
  }

  if (!DISCORD_TOKEN) {
    const varName = usePrefix ? `${prefixArg}_DISCORD_TOKEN` : 'DISCORD_TOKEN';
    console.error(`${varName} is not set in environment variables`);
    process.exit(1);
  }

  if (!CLIENT_ID) {
    const varName = usePrefix ? `${prefixArg}_CLIENT_ID` : 'CLIENT_ID';
    console.error(`${varName} is not set in environment variables`);
    process.exit(1);
  }

  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('registering global application commands');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const data = await registerCommands(DISCORD_TOKEN, CLIENT_ID);

    console.log(`✓ successfully registered ${data.length} command(s)\n`);

    console.log('context menu commands:');
    console.log('  • convert');
    console.log('  • download');
    console.log('  • optimize');

    console.log('\nslash commands:');
    console.log('  • /convert');
    console.log('  • /optimize');
    console.log('  • /download');
    console.log('  • /info');

    const botType = usePrefix ? ` (${prefixArg} bot)` : '';
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`note: commands may take up to 1 hour to appear in discord${botType}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('an error occurred:', error);
    const hint = registerErrorHint(error);
    if (hint) console.error(`   ${hint}.`);
    process.exit(1);
  }
}
