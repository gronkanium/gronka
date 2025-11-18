import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!DISCORD_TOKEN) {
  console.error('discord_token is not set in environment variables');
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error('client_id is not set in environment variables');
  process.exit(1);
}

// Define the commands
const commands = [
  {
    name: 'convert to gif',
    type: 3, // MESSAGE type (right-click on message)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'convert to gif (advanced)',
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
    description: 'convert a video or image to gif',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'file',
        description: 'the video or image file to convert',
        type: 11, // ATTACHMENT type
        required: false,
      },
      {
        name: 'url',
        description: 'url to a video or image file to convert',
        type: 3, // STRING type
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
    description: 'optimize a gif file to reduce its size',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'file',
        description: 'the gif file to optimize',
        type: 11, // ATTACHMENT type
        required: false,
      },
      {
        name: 'url',
        description: 'url to a gif file to optimize',
        type: 3, // STRING type
        required: false,
      },
    ],
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'stats',
    description: 'view bot statistics and gif storage information',
    type: 1, // CHAT_INPUT type (slash command)
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'download',
    description: 'download a video from social media using cobalt (no conversion)',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'url',
        description: 'url to a social media video to download',
        type: 3, // STRING type
        required: true,
      },
    ],
    default_member_permissions: null, // Available to everyone
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
  {
    name: 'config',
    description: 'view or modify your personal configuration settings (admin only)',
    type: 1, // CHAT_INPUT type (slash command)
    options: [
      {
        name: 'view',
        description: 'view your current configuration',
        type: 1, // SUB_COMMAND type
      },
      {
        name: 'set',
        description: 'set configuration values',
        type: 1, // SUB_COMMAND type
        options: [
          {
            name: 'fps',
            description: 'frames per second for gif conversion (max 30 for admins, max 15 for others)',
            type: 10, // NUMBER type
            required: false,
          },
          {
            name: 'width',
            description: 'width in pixels for gif conversion (1-4096)',
            type: 10, // NUMBER type
            required: false,
          },
          {
            name: 'quality',
            description: 'quality preset for gif conversion',
            type: 3, // STRING type
            required: false,
            choices: [
              { name: 'low', value: 'low' },
              { name: 'medium', value: 'medium' },
              { name: 'high', value: 'high' },
            ],
          },
        ],
      },
    ],
    default_member_permissions: null, // Permission check done in handler
    dm_permission: true, // Enable in DMs
    integration_types: [1], // USER_INSTALL - allows users to install the bot directly
    contexts: [0, 1, 2], // GUILD (0), BOT_DM (1), PRIVATE_CHANNEL (2) - enables command usage in all contexts
  },
];

// Construct and prepare an instance of the REST module
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Register commands globally
(async () => {
  try {
    console.log('registering global application (/) commands...');

    // Register commands globally
    const data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

    console.log(`successfully registered ${data.length} global application command(s).`);
    console.log(
      'commands registered: "convert to gif" (context menu), "convert to gif (advanced)" (context menu), "download" (context menu), "optimize" (context menu), "/convert", "/optimize", "/stats", "/download", "/config" (slash commands)'
    );
    console.log('it may take up to an hour for the commands to appear in discord.');
  } catch (error) {
    console.error('an error occured:', error);

    if (error.code === 50001) {
      console.error('   missing access: the bot does not have permission to register commands.');
    } else if (error.code === 50035) {
      console.error('   invalid form body: command structure is invalid.');
    } else if (error.status === 401) {
      console.error('   unauthorized: invalid bot token.');
    }

    process.exit(1);
  }
})();
