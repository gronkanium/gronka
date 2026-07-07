import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  handlePrefixMessage,
  matchPrefix,
  parseArgTokens,
  isValidPrefix,
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
  manageGuild = false,
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
    member: guildId ? { permissions: { has: () => manageGuild } } : null,
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
    stats: [],
    setPrefix: [],
    clearPrefix: [],
  };
  const deps = {
    trackUser: async () => {},
    isAdmin: () => false,
    replyIfBanned: async () => false,
    replyIfMaintenance: async () => false,
    getGuildPrefix: async () => null,
    setGuildPrefix: async (guildId, prefix) => calls.setPrefix.push({ guildId, prefix }),
    clearGuildPrefix: async guildId => calls.clearPrefix.push(guildId),
    handleDownloadCommand: async adapter => calls.download.push(adapter),
    handleConvertCommand: async adapter => calls.convert.push(adapter),
    handleOptimizeCommand: async adapter => calls.optimize.push(adapter),
    handleInfoCommand: async adapter => calls.info.push(adapter),
    handleStatsCommand: async (adapter, botStartTime) =>
      calls.stats.push({ adapter, botStartTime }),
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
      'quality=high',
      'lossy=35',
      'optimize=true',
    ]);
    assert.deepStrictEqual(options, {
      url: 'https://x.com/a',
      start_time: '0:05',
      end_time: '0:10',
      quality: 'high',
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
      start_time: '0:05',
    });
  });

  test('invalid quality values are dropped so the default applies', () => {
    assert.deepStrictEqual(parseArgTokens(['quality=bogus']), {});
    assert.deepStrictEqual(parseArgTokens(['quality=high']), { quality: 'high' });
  });

  test('lossy is clamped to the 0-100 range the slash command enforces', () => {
    assert.deepStrictEqual(parseArgTokens(['lossy=9999']), { lossy: '100' });
    assert.deepStrictEqual(parseArgTokens(['lossy=-5']), { lossy: '0' });
    assert.deepStrictEqual(parseArgTokens(['lossy=35']), { lossy: '35' });
  });
});

describe('isValidPrefix', () => {
  test('accepts short printable prefixes', () => {
    for (const prefix of ['^', '!', '?', '!!', 'g.', '$$$']) {
      assert.strictEqual(isValidPrefix(prefix), true, `expected "${prefix}" to be valid`);
    }
  });

  test('rejects long, spaced, or Discord-special prefixes', () => {
    for (const prefix of ['....', '', ' ', 'a b', '@', '#', '`', '\\', '<', '>', '€']) {
      assert.strictEqual(isValidPrefix(prefix), false, `expected "${prefix}" to be invalid`);
    }
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
    assert.strictEqual(adapter.options.getString('start_time'), '0:05');
    assert.strictEqual(adapter.isPrefixCommand, true);
  });

  test('uses the guild prefix override instead of the default', async () => {
    const { deps, calls } = makeDeps({ getGuildPrefix: async () => '!' });

    await handlePrefixMessage(makeMessage({ content: '!info' }), { deps });
    await handlePrefixMessage(makeMessage({ content: '^g info' }), { deps });

    assert.strictEqual(calls.info.length, 1);
  });

  test('passes botStartTime through to the stats handler', async () => {
    const { deps, calls } = makeDeps();
    await handlePrefixMessage(makeMessage({ content: '^g stats' }), { deps, botStartTime: 12345 });
    assert.strictEqual(calls.stats.length, 1);
    assert.strictEqual(calls.stats[0].botStartTime, 12345);
  });

  test('attaches message attachments as the file option for convert', async () => {
    const { deps, calls } = makeDeps();
    const attachment = { name: 'clip.mp4' };
    const message = makeMessage({ content: '^g convert quality=high', attachments: [attachment] });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.convert.length, 1);
    assert.strictEqual(calls.convert[0].options.getAttachment('file'), attachment);
    assert.strictEqual(calls.convert[0].options.getString('quality'), 'high');
  });

  test('bare mention replies with the help embed', async () => {
    const { deps } = makeDeps();
    const message = makeMessage({ content: `<@${BOT_ID}>` });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(message._replies.length, 1);
    assert.strictEqual(message._replies[0].embeds.length, 1);
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

  test('banned users are blocked before dispatch', async () => {
    const { deps, calls } = makeDeps({ replyIfBanned: async () => true });
    await handlePrefixMessage(makeMessage({ content: '^g download https://x.com/a' }), { deps });
    assert.strictEqual(calls.download.length, 0);
  });

  test('ban and maintenance checks also gate help and prefix', async () => {
    const { deps, calls } = makeDeps({ replyIfBanned: async () => true });

    const help = makeMessage({ content: `<@${BOT_ID}>` });
    await handlePrefixMessage(help, { deps });
    assert.strictEqual(help._replies.length, 0);

    const prefixMsg = makeMessage({ content: '^g prefix !', manageGuild: true });
    await handlePrefixMessage(prefixMsg, { deps });
    assert.strictEqual(calls.setPrefix.length, 0);

    const { deps: maintDeps, calls: maintCalls } = makeDeps({
      replyIfMaintenance: async () => true,
    });
    await handlePrefixMessage(makeMessage({ content: '^g info' }), { deps: maintDeps });
    assert.strictEqual(maintCalls.info.length, 0);
  });

  test('prefix set requires manage server permission', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: `<@${BOT_ID}> prefix !`, manageGuild: false });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.setPrefix.length, 0);
    assert.match(message._replies[0], /manage server/);
  });

  test('prefix set stores a valid prefix for managers', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: '^g prefix !', manageGuild: true });

    await handlePrefixMessage(message, { deps });

    assert.deepStrictEqual(calls.setPrefix, [{ guildId: 'guild-1', prefix: '!' }]);
    assert.match(message._replies[0], /prefix set to `!`/);
  });

  test('prefix reset clears the guild override', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: '^g prefix reset', manageGuild: true });

    await handlePrefixMessage(message, { deps });

    assert.deepStrictEqual(calls.clearPrefix, ['guild-1']);
  });

  test('prefix set rejects invalid prefixes', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: '^g prefix @@@@', manageGuild: true });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.setPrefix.length, 0);
    assert.match(message._replies[0], /prefix must be/);
  });

  test('prefix with no args shows the current prefix without requiring permissions', async () => {
    const { deps, calls } = makeDeps({ getGuildPrefix: async () => '!' });
    const message = makeMessage({ content: '!prefix', manageGuild: false });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.setPrefix.length, 0);
    assert.match(message._replies[0], /`!`/);
  });

  test('prefix cannot be changed in DMs', async () => {
    const { deps, calls } = makeDeps();
    const message = makeMessage({ content: '^g prefix !', guildId: null });

    await handlePrefixMessage(message, { deps });

    assert.strictEqual(calls.setPrefix.length, 0);
    assert.match(message._replies[0], /server/);
  });

  test('bare prefix query still works in DMs', async () => {
    const { deps } = makeDeps();
    const message = makeMessage({ content: '^g prefix', guildId: null });

    await handlePrefixMessage(message, { deps });

    assert.match(message._replies[0], /`\^g`/);
  });
});

describe('buildHelpEmbed', () => {
  test('shows the effective prefix in usage lines', () => {
    const embed = buildHelpEmbed('!').toJSON();
    assert.match(embed.description, /`!`/);
    assert.match(embed.fields[0].value, /! download <url>/);
  });
});
