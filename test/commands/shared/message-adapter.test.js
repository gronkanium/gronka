import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { createMessageAdapter } from '../../../src/commands/shared/message-adapter.js';

/**
 * Minimal fake discord.js Message: records reply payloads and returns sent-message fakes
 * whose .edit() calls are recorded too.
 */
function makeFakeMessage() {
  const sent = [];
  const message = {
    author: { id: 'user-1', tag: 'user#0001', username: 'user' },
    member: null,
    channel: {},
    channelId: 'chan-1',
    guild: { id: 'guild-1' },
    guildId: 'guild-1',
    client: { user: { id: 'bot-1' }, guilds: { cache: { size: 3 } } },
    reply: async payload => {
      const sentMessage = {
        payload,
        edits: [],
        edit: async editPayload => {
          sentMessage.edits.push(editPayload);
          return sentMessage;
        },
      };
      sent.push(sentMessage);
      return sentMessage;
    },
  };
  return { message, sent };
}

describe('createMessageAdapter', () => {
  test('exposes message identity fields and the prefix marker', () => {
    const { message } = makeFakeMessage();
    const adapter = createMessageAdapter(message, {}, { commandName: 'download' });

    assert.strictEqual(adapter.user.id, 'user-1');
    assert.strictEqual(adapter.guildId, 'guild-1');
    assert.strictEqual(adapter.client, message.client);
    assert.strictEqual(adapter.commandName, 'download');
    assert.strictEqual(adapter.isPrefixCommand, true);
    assert.strictEqual(adapter.replied, false);
    assert.strictEqual(adapter.deferred, false);
  });

  test('deferReply sends a placeholder and marks deferred', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.deferReply();

    assert.strictEqual(adapter.deferred, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].payload.content, 'processing...');
  });

  test('editReply edits the deferred placeholder message', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.deferReply();
    await adapter.editReply({ content: 'done!' });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].edits.length, 1);
    assert.strictEqual(sent[0].edits[0].content, 'done!');
  });

  test('a files-only editReply clears the placeholder text', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.deferReply();
    await adapter.editReply({ files: [{ name: 'out.gif' }] });

    assert.strictEqual(sent[0].edits[0].content, '');
  });

  test('editReply before any reply/defer throws', async () => {
    const { message } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await assert.rejects(() => adapter.editReply({ content: 'nope' }));
  });

  test('reply strips interaction-only flags and marks replied', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.reply({ content: 'hi', flags: 64, ephemeral: true });

    assert.strictEqual(adapter.replied, true);
    assert.strictEqual(sent[0].payload.content, 'hi');
    assert.strictEqual('flags' in sent[0].payload, false);
    assert.strictEqual('ephemeral' in sent[0].payload, false);
  });

  test('reply then editReply edits the reply message', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.reply({ content: 'first' });
    await adapter.editReply({ content: 'second' });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].edits[0].content, 'second');
  });

  test('followUp sends an additional message', async () => {
    const { message, sent } = makeFakeMessage();
    const adapter = createMessageAdapter(message);

    await adapter.deferReply();
    await adapter.followUp({ content: 'extra' });

    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].payload.content, 'extra');
  });

  test('option getters coerce values and return null for missing options', () => {
    const { message } = makeFakeMessage();
    const attachment = { name: 'in.gif' };
    const adapter = createMessageAdapter(message, {
      url: 'https://example.com/a',
      lossy: '35',
      bad_number: 'abc',
      optimize: 'true',
      off_flag: 'no',
      file: attachment,
    });

    assert.strictEqual(adapter.options.getString('url'), 'https://example.com/a');
    assert.strictEqual(adapter.options.getString('missing'), null);
    assert.strictEqual(adapter.options.getNumber('lossy'), 35);
    assert.strictEqual(adapter.options.getNumber('bad_number'), null);
    assert.strictEqual(adapter.options.getBoolean('optimize'), true);
    assert.strictEqual(adapter.options.getBoolean('off_flag'), false);
    assert.strictEqual(adapter.options.getBoolean('missing'), null);
    assert.strictEqual(adapter.options.getAttachment('file'), attachment);
    assert.strictEqual(adapter.options.getAttachment('missing'), null);
  });
});
