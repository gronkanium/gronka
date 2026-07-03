import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { initDatabase, banUser, unbanUser, setSetting } from '../src/utils/database.js';
import { invalidateSettingsCache } from '../src/utils/database/settings-pg.js';
import { invalidateBanCache } from '../src/utils/database/bans-pg.js';
import { replyIfBanned } from '../src/utils/ban-check.js';

before(async () => {
  await initDatabase();
});

function makeInteraction(userId) {
  const replies = [];
  return {
    user: { id: userId },
    replied: false,
    deferred: false,
    reply: async options => {
      replies.push(options);
    },
    _replies: replies,
  };
}

describe('replyIfBanned', () => {
  test('does nothing when moderation is disabled, even for a banned user', async () => {
    const userId = `banchk-disabled-${Date.now()}`;
    await setSetting('moderation_enabled', 'false');
    invalidateSettingsCache('moderation_enabled');
    await banUser(userId, 'should be ignored', true);
    invalidateBanCache(userId);

    const interaction = makeInteraction(userId);
    const blocked = await replyIfBanned(interaction);

    assert.strictEqual(blocked, false);
    assert.strictEqual(interaction._replies.length, 0);

    await unbanUser(userId);
  });

  test('lets a non-banned user through when moderation is enabled', async () => {
    await setSetting('moderation_enabled', 'true');
    invalidateSettingsCache('moderation_enabled');

    const interaction = makeInteraction(`banchk-clean-${Date.now()}`);
    const blocked = await replyIfBanned(interaction);

    assert.strictEqual(blocked, false);
    assert.strictEqual(interaction._replies.length, 0);
  });

  test('blocks a banned user and replies with an ephemeral embed including the reason', async () => {
    const userId = `banchk-banned-${Date.now()}`;
    await setSetting('moderation_enabled', 'true');
    invalidateSettingsCache('moderation_enabled');
    await banUser(userId, 'being a menace', true);
    invalidateBanCache(userId);

    const interaction = makeInteraction(userId);
    const blocked = await replyIfBanned(interaction);

    assert.strictEqual(blocked, true);
    assert.strictEqual(interaction._replies.length, 1);

    const [replyOptions] = interaction._replies;
    assert.ok(replyOptions.flags, 'reply should be ephemeral');
    const [embed] = replyOptions.embeds;
    const embedJson = embed.toJSON();
    assert.strictEqual(embedJson.title, 'you have been banned from gronka');
    assert.ok(embedJson.description.includes('being a menace'));
    assert.ok(embedJson.description.includes('you can appeal at:'));

    await unbanUser(userId);
  });

  test('omits the appeal line when appeal_allowed is false', async () => {
    const userId = `banchk-noappeal-${Date.now()}`;
    await setSetting('moderation_enabled', 'true');
    invalidateSettingsCache('moderation_enabled');
    await banUser(userId, 'repeat offender', false);
    invalidateBanCache(userId);

    const interaction = makeInteraction(userId);
    await replyIfBanned(interaction);

    const [replyOptions] = interaction._replies;
    const embedJson = replyOptions.embeds[0].toJSON();
    assert.ok(!embedJson.description.includes('appeal'));

    await unbanUser(userId);
  });
});
