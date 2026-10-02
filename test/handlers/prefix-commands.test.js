import { test, describe } from 'bun:test';
import assert from 'node:assert';
import {
  handlePrefixMessage,
  matchPrefix,
  parseArgTokens,
  buildHelpEmbed,
} from '../../src/handlers/prefix-commands.js';

const BOT_ID = '999888777';

/**
 * Fake discord.js Message for driving handlePrefixMessage without a gateway connection.
 */
function makeMessage({
  content,
  authorBot = false,
  webhookId = null,
  guildId = 'guild-1',
  attachments = [],
} = {}) {
  const replies = [];
  const collection = new Map(attachments.map((a, i) => [String(i), a]));
  collection.first = () => attachments[0];

  return {
    content,
    author: { id: 'user-1', bot: authorBot, tag: 'user#0001', username: 'user' },
    webhookId,
    guildId,
    guild: guildId ? { id: guildId } : null,
    member: null,
    channel: {},
    channelId: 'chan-1',
    attachments: collection,
    reference: null,
    client: { user: { id: BOT_ID } },
    reply: async payload => {
      replies.push(payload);
      return { edit: async () => {} };
    },
    _replies: replies,
  };
}

/**
 * Dependency overrides that avoid the database and record handler dispatches.
 */
function makeDeps(overrides = {}) {
  const calls = {
    download: [],
    convert: [],
    optimize: [],
    info: [],
  };
  const deps = {
    replyIfMaintenance: async () => false,
    handleDownloadCommand: async adapter => calls.download.push(adapter),
    handleConvertCommand: async adapter => calls.convert.push(adapter),
    handleOptimizeCommand: async adapter => calls.optimize.push(adapter),
    handleInfoCommand: async (adapter, botStartTime) => calls.info.push({ adapter, botStartTime }),
    ...overrides,
  };
  return { deps, calls };
}

describe('matchPrefix', () => {
  test('matches the configured prefix', () => {
    const match = matchPrefix('^download https://x.com/a', { prefix: '^', botUserId: BOT_ID });
    assert.deepStrictEqual(match, { rest: 'download https://x.com/a', viaMention: false });
  });

  test('matches a mention of the bot, with or without the nickname form', () => {
    for (const mention of [`<@${BOT_ID}>`, `<@!${BOT_ID}>`]) {
      const match = matchPrefix(`${mention} help`, { prefix: '^', botUserId: BOT_ID });
      assert.deepStrictEqual(match, { rest: 'help', viaMention: true });
    }
  });

  test('ignores mentions of other users and unprefixed messages', () => {
    assert.strictEqual(matchPrefix('<@123> hello', { prefix: '^', botUserId: BOT_ID }), null);
    assert.strictEqual(matchPrefix('just chatting', { prefix: '^', botUserId: BOT_ID }), null);
  });
});

describe('parseArgTokens', () => {
  test('first bare token becomes url, key=value tokens map through aliases', () => {
    const options = parseArgTokens([
      'https://x.com/a',
      'start=0:05',
      'end=0:10',
      'lossy=35',
      'optimize=true',
    ]);
    assert.deepStrictEqual(options, {
      url: 'https://x.com/a',
      start: '0:05',
      end: '0:10',
      lossy: '35',
      optimize: 'true',
    });
  });

  test('unknown keys and extra bare tokens are ignored', () => {
    const options = parseArgTokens(['first', 'second', 'bogus=1']);
    assert.deepStrictEqual(options, { url: 'first' });
  });

  test('urls containing "=" stay intact as the url option', () => {
    const options = parseArgTokens(['https://youtube.com/watch?v=abc123', 'start=0:05']);
    assert.deepStrictEqual(options, {
      url: 'https://youtube.com/watch?v=abc123',
      start: '0:05',
    });
  });

  test('format maps through and invalid formats are dropped', () => {
    assert.deepStrictEqual(parseArgTokens(['format=mp4']), { format: 'mp4' });
    assert.deepStrictEqual(parseArgTokens(['format=GIF']), { format: 'gif' });
    assert.deepStrictEqual(parseArgTokens(['format=exe']), {});
  });

  test('lossy is clamped to the 0-100 range the slash command enforces', () => {
    assert.deepStrictEqual(parseArgTokens(['lossy=9999']), { lossy: '100' });
    assert.deepStrictEqual(parseArgTokens(['lossy=-5']), { lossy: '0' });
    assert.deepStrictEqual(parseArgTokens(['lossy=35']), { lossy: '35' });
  });
});

describe('handlePrefixMessage', () => {
  test('ignores messages from bots and webhooks', async () => {
    const { deps, calls } = makeDeps();
    await handlePrefixMessage(makeMessage({ content: '^download x', authorBot: true }), { deps });
    await handlePrefixMessage(makeMessage({ content: '^download x', webhookId: 'wh1' }), { deps });
    assert.strictEqual(calls.download.length, 0);
  });

  test('dispatches ^g download with the url option populated', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: '^g download https://x.com/a start=0:05' });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.download.length, 1);
    const adapter = calls.download[0];
    assert.strictEqual(adapter.options.getString('url'), 'https://x.com/a');
    assert.strictEqual(adapter.options.getString('start'), '0:05');
    assert.strictEqual(adapter.isPrefixCommand, true);
  });

  test('passes botStartTime through to the info handler', async () => {
    const { deps, calls } = makeDeps();
    await handlePrefixMessage(makeMessage({ content: '^g info' }), { deps, botStartTime: 12345 });
    assert.strictEqual(calls.info.length, 1);
    assert.strictEqual(calls.info[0].botStartTime, 12345);
  });

  test('stats is no longer a command and dispatches nothing', async () => {
    const { deps, calls } = makeDeps();
    await handlePrefixMessage(makeMessage({ content: '^g stats' }), { deps, botStartTime: 12345 });
    assert.strictEqual(calls.info.length, 0);
  });

  test('attaches message attachments as the file option for convert', async () => {
    const { deps, calls } = makeDeps();
    const attachment = { name: 'clip.mp4' };
    const message = makeMessage({ content: '^g convert', attachments: [attachment] });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.convert.length, 1);
    assert.strictEqual(calls.convert[0].options.getAttachment('file'), attachment);
  });

  test('bare mention replies with a compact prompt', async () => {
    const { deps } = makeDeps();
    const message = makeMessage({ content: `<@${BOT_ID}>` });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(message._replies.length, 1);
    const embed = message._replies[0].embeds[0].toJSON();
    assert.strictEqual(embed.fields?.length ?? 0, 0);
    assert.match(embed.description, new RegExp(`<@${BOT_ID}> \`download <url>\``));
  });

  test('explicit help replies with the detailed help embed', async () => {
    const { deps } = makeDeps();
    const message = makeMessage({ content: '^g help' });

    await handlePrefixMessage(message, { deps });

    const embed = message._replies[0].embeds[0].toJSON();
    assert.strictEqual(embed.fields.length, 2);
    assert.match(embed.fields[0].value, /download/);
    assert.match(embed.fields[1].value, /key=value/);
  });

  test('unknown command is silent for prefix but replies for mention', async () => {
    const { deps } = makeDeps();

    const silent = makeMessage({ content: '^g bogus' });
    await handlePrefixMessage(silent, { deps });
    assert.strictEqual(silent._replies.length, 0);

    const mentioned = makeMessage({ content: `<@${BOT_ID}> bogus` });
    await handlePrefixMessage(mentioned, { deps });
    assert.strictEqual(mentioned._replies.length, 1);
    assert.match(mentioned._replies[0], /unknown command/);
  });

  test('maintenance gates every prefix command, help included', async () => {
    const { deps, calls } = makeDeps({ replyIfMaintenance: async () => true });

    const help = makeMessage({ content: `<@${BOT_ID}>` });
    await handlePrefixMessage(help, { deps });
    assert.strictEqual(help._replies.length, 0);

    await handlePrefixMessage(makeMessage({ content: '^g info' }), { deps });
    assert.strictEqual(calls.info.length, 0);
  });

  test('prefix is no longer a command', async () => {
    const { deps } = makeDeps();
    const message = makeMessage({ content: `<@${BOT_ID}> prefix !` });
    await handlePrefixMessage(message, { deps });
    assert.match(message._replies[0], /unknown command/);
  });
});

describe('buildHelpEmbed', () => {
  test('usage lines mention the bot, and the prefix is offered for dms', () => {
    const embed = buildHelpEmbed('!', `<@${BOT_ID}>`).toJSON();
    assert.match(embed.description, /in dms, `!` works/);
    assert.match(embed.fields[0].value, new RegExp(`<@${BOT_ID}> \`download <url>\``));
  });
});
