/**
 * Adapter that wraps a discord.js Message in the ChatInputCommandInteraction surface the
 * command handlers actually consume, so prefix commands ("^download <url>") reuse the slash
 * command handlers unchanged.
 *
 * The handlers only touch interactions through:
 *   - `.user` / `.member` / `.channel` / `.guild` / `.replied` / `.deferred`
 *   - `.options.getString/getAttachment/getBoolean/getNumber`
 *   - the four safeInteraction* helpers (reply / deferReply / editReply / followUp)
 * so that is the whole surface implemented here. Anything else (modals, ephemeral flags)
 * has no message equivalent: `flags` are stripped from every payload because
 * MessageFlags.Ephemeral is invalid on channel messages, and there is no showModal.
 *
 * Reply semantics mapping:
 *   - deferReply()  -> sends a placeholder reply ("processing...") and marks deferred
 *   - editReply()   -> edits the placeholder/first reply (placeholder text is cleared when
 *                      the edit carries files/embeds but no content of its own)
 *   - reply()       -> sends a reply message
 *   - followUp()    -> sends an additional reply message
 * Unlike interactions there is no 3s ack deadline or 15min token expiry - message edits
 * work indefinitely, which makes this path more forgiving for long ffmpeg jobs.
 */

const DEFER_PLACEHOLDER = 'processing...';

/**
 * Strip interaction-only fields from a reply payload so it is valid for channel messages.
 * @param {Object|string} options - Reply options (or bare content string)
 * @returns {Object} Message-safe payload
 */
function toMessagePayload(options) {
  const payload = typeof options === 'string' ? { content: options } : { ...options };
  delete payload.flags; // MessageFlags.Ephemeral is interaction-only
  delete payload.ephemeral;
  return payload;
}

/**
 * Create an interaction-like adapter around a message.
 * @param {import('discord.js').Message} message - The invoking message
 * @param {Object} [namedOptions] - Parsed command options keyed by slash-option name
 *   (e.g. { url, quality, lossy, file }). Values are returned as-is by the getters
 *   after type coercion, so the prefix parser owns validation of raw tokens.
 * @param {Object} [extras]
 * @param {string} [extras.commandName] - Command name for logging parity
 * @returns {Object} ChatInputCommandInteraction-shaped adapter
 */
export function createMessageAdapter(message, namedOptions = {}, extras = {}) {
  let replyMessage = null;

  const send = payload =>
    message.reply({
      ...payload,
      // If the invoking message was deleted mid-processing, degrade to a normal
      // channel message instead of failing the whole command
      failIfNotExists: false,
    });

  const getRaw = name => (namedOptions[name] === undefined ? null : namedOptions[name]);

  const adapter = {
    isPrefixCommand: true,
    commandName: extras.commandName || 'unknown',
    user: message.author,
    member: message.member,
    channel: message.channel,
    channelId: message.channelId,
    guild: message.guild,
    guildId: message.guildId,
    message,
    replied: false,
    deferred: false,

    options: {
      getString(name) {
        const value = getRaw(name);
        return value === null ? null : String(value);
      },
      getNumber(name) {
        const value = getRaw(name);
        if (value === null) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      },
      getBoolean(name) {
        const value = getRaw(name);
        if (value === null) return null;
        if (typeof value === 'boolean') return value;
        return ['true', 'yes', 'on', '1'].includes(String(value).toLowerCase());
      },
      getAttachment(name) {
        return getRaw(name);
      },
    },

    async reply(options) {
      replyMessage = await send(toMessagePayload(options));
      adapter.replied = true;
      return replyMessage;
    },

    async deferReply() {
      replyMessage = await send({ content: DEFER_PLACEHOLDER });
      adapter.deferred = true;
      return true;
    },

    async editReply(options) {
      if (!replyMessage) {
        throw new Error('cannot edit reply before deferReply/reply');
      }
      const payload = toMessagePayload(options);
      // A files/embeds-only edit would otherwise leave the placeholder text in place
      if (payload.content === undefined && (payload.files?.length || payload.embeds?.length)) {
        payload.content = '';
      }
      replyMessage = await replyMessage.edit(payload);
      return replyMessage;
    },

    async followUp(options) {
      return send(toMessagePayload(options));
    },
  };

  return adapter;
}
