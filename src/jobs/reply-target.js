import { Collection, InteractionWebhook, PermissionFlagsBits } from 'discord.js';
import { getDiscordAttachmentLimit } from '../commands/shared/attachment-limit.js';

const INTERACTION_TOKEN_MS = 15 * 60 * 1000;
const MESSAGE_REPLY_MS = 60 * 60 * 1000;

export async function prepareReplyTarget(interaction) {
  const reply = replyTargetOf(interaction);
  const member = interaction.guild?.members?.me;
  const permissions = member && interaction.channel?.permissionsFor?.(member);
  if (
    interaction.ephemeral ||
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      interaction.channel?.isThread?.()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages,
    ])
  )
    return reply;
  const message = await interaction.fetchReply();
  if (message.flags?.has?.(64)) return reply;
  return {
    ...reply,
    replyId: message.id,
    webhookExpiresAt: reply.expiresAt,
    expiresAt: interaction.createdTimestamp + MESSAGE_REPLY_MS,
  };
}

// Where a job's answer goes, as plain JSON for the queue.
export function replyTargetOf(interaction) {
  return {
    appId: interaction.applicationId,
    token: interaction.token,
    channelId: interaction.channelId,
    attachmentSizeLimit: getDiscordAttachmentLimit(interaction, null),
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
  const webhook = new InteractionWebhook(client, reply.appId, reply.token);
  let useChannel = Boolean(reply.replyId && Date.now() >= reply.webhookExpiresAt);
  const send = async (options, followUp = false) => {
    if (!useChannel) {
      try {
        return asMessage(
          await (followUp ? webhook.send(options) : webhook.editMessage('@original', options))
        );
      } catch (error) {
        if (!reply.replyId || ![10015, 50027].includes(error.code)) throw error;
        useChannel = true;
      }
    }
    const channel = await fetchChannel(client, reply.channelId);
    return followUp ? channel.send(options) : channel.messages.edit(reply.replyId, options);
  };
  const edit = options => send(options);
  return {
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
    followUp: options => send(options, true),
  };
}
