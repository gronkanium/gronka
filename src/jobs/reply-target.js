import { Collection, InteractionWebhook } from 'discord.js';
import { createMessageAdapter } from '../commands/shared/message-adapter.js';

const INTERACTION_TOKEN_MS = 15 * 60 * 1000;
const MESSAGE_REPLY_MS = 60 * 60 * 1000;

// Where a job's answer goes, as plain JSON for the queue.
export function replyTargetOf(interaction) {
  if (interaction.isPrefixCommand) {
    return {
      kind: 'message',
      channelId: interaction.channelId,
      messageId: interaction.message.id,
      replyId: interaction.replyMessageId(),
      expiresAt: Date.now() + MESSAGE_REPLY_MS,
    };
  }
  return {
    kind: 'interaction',
    appId: interaction.applicationId,
    token: interaction.token,
    channelId: interaction.channelId,
    attachmentSizeLimit: interaction.attachmentSizeLimit ?? null,
    expiresAt: interaction.createdTimestamp + INTERACTION_TOKEN_MS,
  };
}

// A webhook edit of an uncached channel returns raw JSON; callers expect attachments.first().
const asMessage = data =>
  Array.isArray(data?.attachments)
    ? { ...data, attachments: new Collection(data.attachments.map(a => [a.id, a])) }
    : data;

const fetchChannel = (client, id) => client.channels.fetch(id, { allowUnknownGuild: true });

// Rebuilds the interaction surface the commands use, over REST only (no gateway session).
export async function interactionFor(client, job) {
  const { reply } = job;
  const user = { id: job.user_id };
  if (reply.kind === 'message') {
    const channel = await fetchChannel(client, reply.channelId);
    // Edits go straight to REST: a REST-fetched message has no cached channel to edit through.
    const replyMessage = reply.replyId && {
      id: reply.replyId,
      edit: payload => channel.messages.edit(reply.replyId, payload),
    };
    const message = {
      id: reply.messageId,
      author: user,
      channel,
      channelId: reply.channelId,
      client,
      reply: payload =>
        channel.send({
          ...payload,
          reply: { messageReference: reply.messageId, failIfNotExists: false },
        }),
    };
    return createMessageAdapter(message, {}, { replyMessage });
  }
  const webhook = new InteractionWebhook(client, reply.appId, reply.token);
  const edit = async options => asMessage(await webhook.editMessage('@original', options));
  return {
    user,
    client,
    applicationId: reply.appId,
    channelId: reply.channelId,
    attachmentSizeLimit: reply.attachmentSizeLimit ?? undefined,
    channel: reply.channelId
      ? {
          messages: {
            fetch: async id => (await fetchChannel(client, reply.channelId)).messages.fetch(id),
          },
        }
      : null,
    deferred: true,
    replied: false,
    deferReply: async () => true,
    reply: edit,
    editReply: edit,
    followUp: async options => asMessage(await webhook.send(options)),
  };
}
