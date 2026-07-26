import { describe, test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { ClientPresence, ActivityType } from 'discord.js';
import {
  VALID_PRESENCE_STATUSES,
  DEFAULT_PRESENCE_STATUS,
  buildPresenceOptions,
  activityDisplayText,
  loadSavedPresence,
  saveSavedPresence,
} from '../../src/utils/presence.js';
import { initDatabase, setSetting } from '../../src/utils/database.js';

describe('presence options', () => {
  test('builds a custom status activity', () => {
    const options = buildPresenceOptions('dnd', 'we crashed but we back');
    assert.strictEqual(options.status, 'dnd');
    assert.deepStrictEqual(options.activities, [
      { name: 'Custom Status', state: 'we crashed but we back', type: ActivityType.Custom },
    ]);
  });

  test('omits activities entirely when there is no text', () => {
    // setPresence clears activities when the key is absent - an empty array would be a
    // different thing to reason about, so make sure the key simply is not there.
    assert.deepStrictEqual(buildPresenceOptions('idle', ''), { status: 'idle' });
    assert.deepStrictEqual(buildPresenceOptions('idle', null), { status: 'idle' });
  });

  test('omits status when only the activity changes', () => {
    assert.deepStrictEqual(buildPresenceOptions(null, 'hello'), {
      activities: [{ name: 'Custom Status', state: 'hello', type: ActivityType.Custom }],
    });
  });
});

describe('activityDisplayText', () => {
  test('reads a custom status from state, not the fixed name', () => {
    const activity = { type: ActivityType.Custom, name: 'Custom Status', state: 'hello there' };
    assert.strictEqual(activityDisplayText(activity), 'hello there');
  });

  test('reads other activity types from name', () => {
    assert.strictEqual(
      activityDisplayText({ type: ActivityType.Playing, name: 'with fire' }),
      'with fire'
    );
  });

  test('returns null when there is nothing to show', () => {
    assert.strictEqual(activityDisplayText(null), null);
    assert.strictEqual(
      activityDisplayText({ type: ActivityType.Custom, name: 'Custom Status' }),
      null
    );
  });
});

describe('presence round trip through discord.js', () => {
  // discord.js rewrites {name: text, type: Custom} into {name: 'Custom Status', state: text}
  // before it hits the wire. Reading `name` back therefore reports the literal string
  // "Custom Status" instead of what was set - pin the shape so that cannot regress.
  // _parse touches nothing on the client, so a stub keeps this off the network.
  const presence = new ClientPresence({});

  test('what goes out is what reads back', () => {
    const text = 'we crashed but we back';
    const packet = presence._parse(buildPresenceOptions('dnd', text));

    assert.strictEqual(packet.status, 'dnd');
    assert.strictEqual(packet.activities.length, 1);
    assert.strictEqual(packet.activities[0].type, ActivityType.Custom);
    assert.strictEqual(packet.activities[0].name, 'Custom Status');
    assert.strictEqual(packet.activities[0].state, text);
    assert.strictEqual(activityDisplayText(packet.activities[0]), text);
  });

  test('a status-only presence sends no activities', () => {
    const packet = presence._parse(buildPresenceOptions('online', ''));
    assert.strictEqual(packet.status, 'online');
    assert.deepStrictEqual(packet.activities, []);
  });
});

describe('saved presence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  test('round trips status and activity', async () => {
    await saveSavedPresence('idle', 'saved activity text');
    assert.deepStrictEqual(await loadSavedPresence(), {
      status: 'idle',
      activity: 'saved activity text',
    });
  });

  test('a status-only update clears the stored activity', async () => {
    await saveSavedPresence('online', 'to be cleared');
    await saveSavedPresence('dnd', null);
    assert.deepStrictEqual(await loadSavedPresence(), { status: 'dnd', activity: '' });
  });

  test('falls back to the default status when the stored one is unusable', async () => {
    await setSetting('bot_presence_status', 'nonsense');
    const { status } = await loadSavedPresence();
    assert.strictEqual(status, DEFAULT_PRESENCE_STATUS);
    assert.ok(VALID_PRESENCE_STATUSES.includes(status));
  });
});
