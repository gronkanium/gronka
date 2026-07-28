import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { trackUser } from '../utils/user-tracking.js';
import { isAdmin } from '../utils/rate-limit.js';
import { replyIfBanned, replyIfMaintenance } from '../utils/ban-check.js';
import { getGuildPrefix, setGuildPrefix, clearGuildPrefix } from '../utils/database.js';
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
  start: 'start_time',
  start_time: 'start_time',
  end: 'end_time',
  end_time: 'end_time',
  quality: 'quality',
  optimize: 'optimize',
  lossy: 'lossy',
  url: 'url',
};

/**
 * Validate a candidate custom prefix: 1-3 printable ASCII chars, no whitespace, and none
 * of the characters Discord parses specially (mentions, channels, code, backslash).
 * @param {string} prefix
 * @returns {boolean}
 */
export function isValidPrefix(prefix) {
  return /^[!-~]{1,3}$/.test(prefix) && !/[@#`\\<>]/.test(prefix);
}

/**
 * Match a message's content against the bot mention or the effective prefix.
 * @param {string} content - Raw message content
 * @param {Object} params
 * @param {string} params.prefix - Effective prefix for this guild/DM
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

/**
 * Parse command argument tokens into slash-shaped named options. A token only counts as
 * key=value when the key is a known option alias - URLs routinely contain "=" (e.g.
 * youtube.com/watch?v=...) and must stay intact as the bare `url` token. Values that the
 * slash UI would have constrained (quality choices, lossy range) are normalized here since
 * prefix input is free-form.
 * @param {string[]} tokens - Whitespace-split tokens after the command name
 * @returns {Object} Named options keyed by slash option name
 */
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

  // Slash commands restrict quality via choices; drop anything else so the default applies
  if (options.quality !== undefined && !['low', 'medium', 'high'].includes(options.quality)) {
    delete options.quality;
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

/**
 * Resolve the attachment a convert/optimize prefix command should operate on: an attachment
 * on the invoking message, or one on the message it replies to.
 * @param {import('discord.js').Message} message
 * @returns {Promise<import('discord.js').Attachment|null>}
 */
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

export function buildHelpEmbed(prefix) {
  return new EmbedBuilder()
    .setTitle('gronka')
    .setColor(EMBED_COLOR)
    .setDescription(
      `media bot: download from social media, convert videos/images to gif, optimize gifs.\n` +
        `prefix here is \`${prefix}\` — mentioning me works too. slash commands (\`/download\` etc.) also work.`
    )
    .addFields(
      {
        name: 'commands',
        value: [
          `\`${prefix} download <url>\` — download a video from social media`,
          `\`${prefix} convert [url]\` — convert a video/image to gif (attach a file, link one, or reply to a message with one)`,
          `\`${prefix} optimize [url]\` — shrink a gif (attachment, url, or reply)`,
          `\`${prefix} info\` — bot stats and system info`,
          `\`${prefix} help\` — this message`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'options',
        value:
          `\`key=value\` after a command, e.g. \`${prefix} convert quality=high lossy=35 start=0:05 end=0:10\`\n` +
          `server managers can change the prefix with \`${prefix} prefix <new>\` or \`${prefix} prefix reset\``,
        inline: false,
      }
    );
}

/**
 * Handle the "prefix" command: show, set, or reset this guild's prefix.
 * Setting/resetting requires the Manage Server permission (or bot admin).
 * @param {import('discord.js').Message} message
 * @param {string[]} tokens - Arguments after "prefix"
 * @param {string} currentPrefix - Effective prefix for this guild
 * @param {Object} deps - Injected dependencies (see handlePrefixMessage)
 * @returns {Promise<void>}
 */
async function handlePrefixSetting(message, tokens, currentPrefix, deps) {
  if (tokens.length === 0) {
    await message.reply(`my prefix here is \`${currentPrefix}\` — you can always mention me too.`);
    return;
  }

  if (!message.guildId) {
    await message.reply('the prefix can only be changed in a server.');
    return;
  }

  const isManager =
    message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    deps.isAdmin(message.author.id);
  if (!isManager) {
    await message.reply('you need the manage server permission to change the prefix.');
    return;
  }

  const requested = tokens[0];

  if (requested === 'reset' || requested === 'default') {
    await deps.clearGuildPrefix(message.guildId);
    logger.info(`Prefix reset to default in guild ${message.guildId} by ${message.author.id}`);
    await message.reply(`prefix reset to the default \`${botConfig.commandPrefix}\`.`);
    return;
  }

  if (!isValidPrefix(requested)) {
    await message.reply(
      'prefix must be 1-3 characters with no spaces, and cannot contain `@`, `#`, `<`, `>`, backticks, or backslashes.'
    );
    return;
  }

  await deps.setGuildPrefix(message.guildId, requested);
  logger.info(`Prefix set to "${requested}" in guild ${message.guildId} by ${message.author.id}`);
  await message.reply(
    `prefix set to \`${requested}\` for this server. use \`${requested} help\` or mention me if you forget it.`
  );
}

const defaultDeps = {
  trackUser,
  isAdmin,
  replyIfBanned,
  replyIfMaintenance,
  getGuildPrefix,
  setGuildPrefix,
  clearGuildPrefix,
  handleDownloadCommand,
  handleConvertCommand,
  handleOptimizeCommand,
  handleInfoCommand,
};

/**
 * MessageCreate entry point for prefix commands. Ignores bots/webhooks, resolves the
 * effective prefix (guild override or default) plus @mention-as-prefix, and dispatches to
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

  let prefix = botConfig.commandPrefix;
  if (message.guildId) {
    try {
      prefix = (await deps.getGuildPrefix(message.guildId)) ?? prefix;
    } catch (error) {
      logger.error(`Failed to resolve guild prefix for ${message.guildId}:`, error);
    }
  }

  const match = matchPrefix(message.content, { prefix, botUserId });
  if (!match) {
    return;
  }

  const tokens = match.rest.split(/\s+/).filter(Boolean);
  const commandName = (tokens.shift() || '').toLowerCase();

  // Bare @mention: introduce the bot
  const isHelp = commandName === 'help' || (match.viaMention && commandName === '');

  const knownCommands = ['download', 'convert', 'optimize', 'info', 'stats', 'prefix'];
  if (!isHelp && !knownCommands.includes(commandName)) {
    if (match.viaMention) {
      await message
        .reply(`unknown command. try \`${prefix} help\` or mention me with no command.`)
        .catch(error => logger.debug(`Failed to send unknown-command reply: ${error.message}`));
    }
    return;
  }

  const username = message.author.tag || message.author.username || 'unknown';
  deps.trackUser(message.author.id, username).catch(error => {
    logger.debug(`Failed to track user ${message.author.id}: ${error.message}`);
  });

  try {
    const namedOptions = parseArgTokens(tokens);
    if (commandName === 'convert' || commandName === 'optimize') {
      namedOptions.file = await resolveAttachment(message);
    }

    const adapter = createMessageAdapter(message, namedOptions, {
      commandName: isHelp ? 'help' : commandName,
    });

    // Same gauntlet the interaction handler runs before dispatching anything
    if (await deps.replyIfBanned(adapter)) {
      return;
    }
    if (await deps.replyIfMaintenance(adapter)) {
      return;
    }

    if (isHelp) {
      await message.reply({ embeds: [buildHelpEmbed(prefix)] });
      return;
    }

    if (commandName === 'prefix') {
      await handlePrefixSetting(message, tokens, prefix, deps);
      return;
    }

    logger.info(
      `User ${message.author.id} (${username}) invoked prefix command "${commandName}" in ${message.guildId || 'DM'}`
    );

    if (commandName === 'download') {
      await deps.handleDownloadCommand(adapter);
    } else if (commandName === 'convert') {
      await deps.handleConvertCommand(adapter);
    } else if (commandName === 'optimize') {
      await deps.handleOptimizeCommand(adapter);
    } else if (commandName === 'info' || commandName === 'stats') {
      // `stats` was its own command until it merged into `info`; kept as an undocumented
      // alias so muscle memory and older guides keep working.
      await deps.handleInfoCommand(adapter, context.botStartTime ?? null);
    }
  } catch (error) {
    logger.error(`Unhandled error in prefix command "${commandName}":`, error);
  }
}
