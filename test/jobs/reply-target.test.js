import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder, Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { interactionFor, replyTargetOf } from '../../src/jobs/reply-target.js';
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
