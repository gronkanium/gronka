/**
 * Minimal in-process stand-in for a discord.js ChatInputCommandInteraction, enough to drive the
 * command lifecycle (runMediaCommand + interaction-helpers) without a live Discord connection.
 *
 * Records every reply/editReply/deferReply/followUp call so tests can assert exactly what the user
 * would have seen — this is the path the unit tests don't cover.
 *
 * @param {Object} [opts]
 * @param {string} [opts.userId]
 * @param {string} [opts.tag]
 * @param {boolean} [opts.deferred] - Start "deferred" so editReply works (handlers defer first).
 * @param {Array} [opts.messageAttachments] - Attachments the edited message should report back
 *   (each: { url }). Returned as a Discord-Collection-like object (size / values / first).
 * @returns {{ interaction: Object, calls: { reply: any[], editReply: any[], deferReply: any[], followUp: any[] } }}
 */
export function createFakeInteraction(opts = {}) {
  const { userId = 'e2e-user', tag = 'e2e#0001', deferred = true, messageAttachments = [] } = opts;

  const calls = { reply: [], editReply: [], deferReply: [], followUp: [] };

  const toCollection = items => {
    const map = new Map(items.map((it, i) => [String(i), it]));
    map.first = () => items[0];
    return map;
  };

  const makeMessage = () => ({
    id: 'fake-message-id',
    attachments: toCollection(messageAttachments),
  });

  const interaction = {
    user: { id: userId, tag, username: tag.split('#')[0] },
    commandName: 'test',
    replied: false,
    deferred,
    channel: {
      messages: {
        fetch: async () => makeMessage(),
      },
    },
    async reply(options) {
      calls.reply.push(options);
      this.replied = true;
      return makeMessage();
    },
    async editReply(options) {
      calls.editReply.push(options);
      return makeMessage();
    },
    async deferReply(options = {}) {
      calls.deferReply.push(options);
      this.deferred = true;
      return true;
    },
    async followUp(options) {
      calls.followUp.push(options);
      return makeMessage();
    },
  };

  return { interaction, calls };
}
