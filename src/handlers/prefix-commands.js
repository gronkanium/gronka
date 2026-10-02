import { EmbedBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { replyIfMaintenance } from '../utils/maintenance.js';
import { OUTPUT_FORMATS } from '../utils/output-formats.js';
import { createMessageAdapter } from '../commands/shared/message-adapter.js';
import { handleDownloadCommand } from '../commands/download.js';
import { handleConvertCommand } from '../commands/convert.js';
import { handleOptimizeCommand } from '../commands/optimize.js';
import { handleInfoCommand } from '../commands/info.js';

const logger = createLogger('prefix-commands');

const EMBED_COLOR = 0x5865f2; // same blurple as /info

// Aliases for key=value option tokens -> slash option names, so "^convert start=0:05"
// lands in the same option the slash handler reads via resolveTimeOptions
const OPTION_ALIASES = {
  start: 'start',
  start_time: 'start',
  end: 'end',
  end_time: 'end',
  optimize: 'optimize',
  lossy: 'lossy',
  mp3: 'mp3',
  format: 'format',
  url: 'url',
};

/**
 * Match a message's content against the bot mention or the effective prefix.
 * @param {string} content - Raw message content
 * @param {Object} params
 * @param {string} params.prefix - The default prefix
 * @param {string} params.botUserId - The bot's user ID (for mention matching)
 * @returns {{ rest: string, viaMention: boolean }|null} Remaining text after the prefix,
 *   or null when the message is not addressed to the bot
 */
export function matchPrefix(content, { prefix, botUserId }) {
  const mentionMatch = content.match(/^<@!?(\d+)>\s*/);
  if (mentionMatch) {
    if (mentionMatch[1] !== botUserId) {
      return null;
    }
    return { rest: content.slice(mentionMatch[0].length).trim(), viaMention: true };
  }

  if (prefix && content.startsWith(prefix)) {
    return { rest: content.slice(prefix.length).trim(), viaMention: false };
  }

  return null;
}

// Parse command argument tokens into slash-shaped named options
export function parseArgTokens(tokens) {
  const options = {};

  for (const token of tokens) {
    const eq = token.indexOf('=');
    const key = eq > 0 ? OPTION_ALIASES[token.slice(0, eq).toLowerCase()] : undefined;
    if (key) {
      const value = token.slice(eq + 1);
      if (value) {
        options[key] = value;
      }
      continue;
    }
    if (options.url === undefined) {
      options.url = token;
    }
  }

  if (options.format !== undefined) {
    options.format = options.format.toLowerCase();
    if (options.format !== 'gif' && !OUTPUT_FORMATS[options.format]) delete options.format;
  }

  // Slash commands enforce 0-100 via min/max; clamp here (non-numeric values are dropped
  // later by the adapter's getNumber)
  if (options.lossy !== undefined) {
    const lossy = Number(options.lossy);
    if (Number.isFinite(lossy)) {
      options.lossy = String(Math.min(100, Math.max(0, lossy)));
    }
  }

  return options;
}

// Resolve the attachment a convert/optimize prefix command should operate on: an attachment on the invoking message, or one on the message it replies to
async function resolveAttachment(message) {
  const own = message.attachments.first();
  if (own) {
    return own;
  }

  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      return referenced.attachments.first() ?? null;
    } catch (error) {
      logger.debug(`Could not fetch referenced message: ${error.message}`);
    }
  }

  return null;
}

// No Message Content intent: in a server Discord only delivers messages that mention gronka.
export function buildHelpEmbed(prefix, me = '@gronka') {
  return new EmbedBuilder()
    .setTitle('gronka')
    .setColor(EMBED_COLOR)
    .setDescription(
      `media bot: download from social media, convert videos/images to gif, optimize gifs.\n` +
        `mention me to run a command, or use slash commands (\`/download\` etc.). in dms, \`${prefix}\` works too.`
    )
    .addFields(
      {
        name: 'commands',
        value: [
          `${me} \`download <url>\`, download a video from social media (\`mp3=true\` for audio only)`,
          `${me} \`convert [url]\`, convert a video/image to gif, mp4 or another format (attach a file or link one)`,
          `${me} \`optimize [url]\`, shrink a gif (attach it or link one)`,
          `${me} \`info\`, bot stats and system info`,
          `${me} \`help\`, this message`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'options',
        value: `\`key=value\` after a command, e.g. ${me} \`convert format=mp4 start=0:05 end=0:10\``,
        inline: false,
      }
    );
}

function buildMentionEmbed(me) {
  return new EmbedBuilder()
    .setTitle('gronka')
    .setColor(EMBED_COLOR)
    .setDescription(
      `send me a link with ${me} \`download <url>\`, or ${me} \`help\` for the full menu.`
    );
}

const defaultDeps = {
  replyIfMaintenance,
  handleDownloadCommand,
  handleConvertCommand,
  handleOptimizeCommand,
  handleInfoCommand,
};

/**
 * MessageCreate entry point for prefix commands. Ignores bots/webhooks, matches the
 * default prefix (DMs) or an @mention, and dispatches to
 * the existing slash command handlers through the message adapter.
 *
 * Unknown commands after a prefix are ignored silently (another bot may share the prefix);
 * unknown commands after an explicit @mention get a short pointer to help.
 *
 * @param {import('discord.js').Message} message
 * @param {Object} [context]
 * @param {number|null} [context.botStartTime] - For the info command's uptime field
 * @param {Object} [context.deps] - Dependency overrides for tests
 * @returns {Promise<void>}
 */
export async function handlePrefixMessage(message, context = {}) {
  const deps = { ...defaultDeps, ...(context.deps || {}) };

  if (message.author?.bot || message.webhookId || !message.content) {
    return;
  }

  const botUserId = message.client?.user?.id;
  if (!botUserId) {
    return;
  }

  const prefix = botConfig.commandPrefix;

  const match = matchPrefix(message.content, { prefix, botUserId });
  if (!match) {
    return;
  }

  const tokens = match.rest.split(/\s+/).filter(Boolean);
  const commandName = (tokens.shift() || '').toLowerCase();

  // Bare @mention: introduce the bot
  const isBareMention = match.viaMention && commandName === '';
  const isHelp = commandName === 'help' || isBareMention;

  const knownCommands = ['download', 'convert', 'optimize', 'info'];
  if (!isHelp && !knownCommands.includes(commandName)) {
    if (match.viaMention) {
      await message
        .reply(`unknown command. try <@${botUserId}> help.`)
        .catch(error => logger.debug(`Failed to send unknown-command reply: ${error.message}`));
    }
    return;
  }

  try {
    const namedOptions = parseArgTokens(tokens);
    if (commandName === 'convert' || commandName === 'optimize') {
      namedOptions.file = await resolveAttachment(message);
    }

    const adapter = createMessageAdapter(message, namedOptions, {
      commandName: isHelp ? 'help' : commandName,
    });

    // Same gauntlet the interaction handler runs before dispatching anything
    if (await deps.replyIfMaintenance(adapter)) {
      return;
    }

    if (isHelp) {
      await message.reply({
        embeds: [
          isBareMention
            ? buildMentionEmbed(`<@${botUserId}>`)
            : buildHelpEmbed(prefix, `<@${botUserId}>`),
        ],
      });
      return;
    }

    if (commandName === 'download') {
      await deps.handleDownloadCommand(adapter);
    } else if (commandName === 'convert') {
      await deps.handleConvertCommand(adapter);
    } else if (commandName === 'optimize') {
      await deps.handleOptimizeCommand(adapter);
    } else if (commandName === 'info') {
      await deps.handleInfoCommand(adapter, context.botStartTime ?? null);
    }
  } catch (error) {
    // 50013/50001: can't post in that channel. Guild permissions, not a defect.
    if (error?.code === 50013 || error?.code === 50001) {
      logger.debug(
        `Cannot reply to prefix command "${isHelp ? 'help' : commandName}" in ${message.guildId || 'DM'}: ${error.message}`
      );
      return;
    }
    logger.error(`Unhandled error in prefix command "${isHelp ? 'help' : commandName}":`, error);
  }
}
