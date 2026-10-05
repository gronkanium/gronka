import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder, Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { interactionFor, replyTargetOf, prepareReplyTarget } from '../../src/jobs/reply-target.js';
import { getDiscordAttachmentLimit } from '../../src/commands/shared/attachment-limit.js';
import { safeInteractionEditReply } from '../../src/utils/interaction-helpers.js';
import { startFakeDiscordApi } from '../helpers/fake-discord-api.js';

let api;
let client;
const file = path.join(os.tmpdir(), `reply-target-${process.pid}.gif`);

beforeAll(() => {
  api = startFakeDiscordApi();
  client = new Client({ intents: [], rest: { api: api.url } });
  client.token = 'test-token';
  client.rest.setToken('test-token');
  fs.writeFileSync(file, Buffer.from('GIF89a-bytes'));
});
afterAll(() => {
  api.stop();
  fs.rmSync(file, { force: true });
});

describe('job reply targets', () => {
  test('public guild replies keep routing only in the active job', async () => {
    const permissions = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]);
    const interaction = {
      applicationId: 'app',
      token: 'tok',
      channelId: '77',
      createdTimestamp: Date.now(),
      guild: { members: { me: {} } },
      channel: { permissionsFor: () => permissions },
      fetchReply: async () => ({ id: '11' }),
    };
    const reply = await prepareReplyTarget(interaction);
    assert.strictEqual(reply.replyId, '11');
    assert.strictEqual(reply.webhookExpiresAt, interaction.createdTimestamp + 15 * 60 * 1000);
    assert.strictEqual(reply.expiresAt, interaction.createdTimestamp + 60 * 60 * 1000);
    interaction.ephemeral = true;
    assert.strictEqual((await prepareReplyTarget(interaction)).replyId, undefined);
    interaction.ephemeral = false;
    interaction.channel.permissionsFor = () => new PermissionsBitField();
    assert.strictEqual((await prepareReplyTarget(interaction)).replyId, undefined);
  });

  test('an expired public interaction edits the same message with bot authentication', async () => {
    const interaction = await interactionFor(client, {
      reply: {
        kind: 'interaction',
        appId: 'app',
        token: 'tok',
        channelId: '77',
        replyId: '11',
        webhookExpiresAt: 0,
      },
    });
    await interaction.editReply({ files: [new AttachmentBuilder(file, { name: 'out.gif' })] });
    const edit = api.calls.at(-1);
    assert.strictEqual(edit.path, '/channels/77/messages/11');
    assert.deepStrictEqual(edit.files, [{ name: 'out.gif', size: 12 }]);
    await interaction.followUp({ content: 'part two' });
    assert.strictEqual(api.calls.at(-1).path, '/channels/77/messages');
    assert.strictEqual(interaction.isPrefixCommand, undefined);
  });

  test('an interaction target round-trips through the queue JSON', () => {
    const interaction = {
      applicationId: 'app',
      token: 'tok',
      channelId: '5',
      attachmentSizeLimit: 10,
      createdTimestamp: 1000,
    };
    const target = JSON.parse(JSON.stringify(replyTargetOf(interaction)));
    assert.deepStrictEqual(target, {
      kind: 'interaction',
      appId: 'app',
      token: 'tok',
      channelId: '5',
      attachmentSizeLimit: 10,
      expiresAt: 1000 + 15 * 60 * 1000,
    });
  });

  test('a channel without Attach Files queues a zero limit for both kinds', async () => {
    const appPermissions = new PermissionsBitField(PermissionFlagsBits.SendMessages);
    const slash = replyTargetOf({ appPermissions, attachmentSizeLimit: 10, createdTimestamp: 0 });
    assert.strictEqual(slash.attachmentSizeLimit, 0);
    const prefix = replyTargetOf({
      isPrefixCommand: true,
      appPermissions,
      channelId: '77',
      message: { id: '10' },
      replyMessageId: () => '11',
    });
    assert.strictEqual(prefix.attachmentSizeLimit, 0);
    const worker = await interactionFor(client, { reply: JSON.parse(JSON.stringify(prefix)) });
    assert.strictEqual(getDiscordAttachmentLimit(worker, 8), 0);
  });

  test('a worker edits the original interaction reply with a file by path', async () => {
    const job = {
      reply: { kind: 'interaction', appId: 'app', token: 'tok', channelId: '5' },
    };
    const interaction = await interactionFor(client, job);
    const sent = await safeInteractionEditReply(interaction, {
      files: [new AttachmentBuilder(file, { name: 'out.gif' })],
    });
    const call = api.calls.at(-1);
    assert.strictEqual(call.method, 'PATCH');
    assert.strictEqual(decodeURIComponent(call.path), '/webhooks/app/tok/messages/@original');
    assert.deepStrictEqual(call.files, [{ name: 'out.gif', size: 12 }]);
    assert.ok(sent.attachments.first().url.endsWith('/out.gif'));
    assert.strictEqual(interaction.user, undefined);
  });

  test('token rejection recovers through the existing public message', async () => {
    const interaction = await interactionFor(client, {
      reply: {
        kind: 'interaction',
        appId: 'app',
        token: 'expired',
        channelId: '77',
        replyId: '11',
        webhookExpiresAt: Date.now() + 60_000,
      },
    });
    api.failures.set('/webhooks/app/expired/messages/@original', { code: 50027, status: 401 });
    await interaction.editReply({ content: 'done' });
    assert.strictEqual(api.calls.at(-1).path, '/channels/77/messages/11');
  });

  test('a permission rejection is not redirected to a channel message', async () => {
    const interaction = await interactionFor(client, {
      reply: {
        kind: 'interaction',
        appId: 'app',
        token: 'denied',
        channelId: '77',
        replyId: '11',
        webhookExpiresAt: Date.now() + 60_000,
      },
    });
    api.failures.set('/webhooks/app/denied/messages/@original', { code: 50013, status: 403 });
    await assert.rejects(interaction.editReply({ content: 'done' }), error => error.code === 50013);
    assert.strictEqual(
      decodeURIComponent(api.calls.at(-1).path),
      '/webhooks/app/denied/messages/@original'
    );
  });

  test('a worker follows up on an interaction', async () => {
    const job = { reply: { kind: 'interaction', appId: 'app', token: 'tok' } };
    const interaction = await interactionFor(client, job);
    await interaction.followUp({ content: 'part two' });
    const call = api.calls.at(-1);
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.path, '/webhooks/app/tok');
    assert.strictEqual(call.body.content, 'part two');
  });

  test('a worker edits a prefix command placeholder and replies to the command', async () => {
    const job = {
      reply: { kind: 'message', channelId: '77', messageId: '10', replyId: '11' },
    };
    const interaction = await interactionFor(client, job);
    assert.strictEqual(interaction.deferred, true);
    await safeInteractionEditReply(interaction, { content: 'done' });
    const edit = api.calls.at(-1);
    assert.strictEqual(edit.method, 'PATCH');
    assert.strictEqual(edit.path, '/channels/77/messages/11');
    assert.strictEqual(edit.body.content, 'done');
    await interaction.followUp({ content: 'more' });
    const followUp = api.calls.at(-1);
    assert.strictEqual(followUp.path, '/channels/77/messages');
    assert.strictEqual(followUp.body.message_reference.message_id, '10');
  });
});
