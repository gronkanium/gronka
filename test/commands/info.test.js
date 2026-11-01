import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { infoEmbed, memoryLine, queueLine, formatDuration } from '../../src/commands/info.js';

const MB = 1024 ** 2;
const proc = (role, rss, live = true) => ({ id: `abc123def456-${rss}`, role, rss: rss * MB, live });
const overview = (extra = {}) => ({
  paused: false,
  counts: { queued: 3, running: 1 },
  processes: [proc('bot', 90), proc('worker', 70), proc('worker', 80), proc('worker', 500, false)],
  ...extra,
});
const client = { uptime: 65 * 60_000, guilds: { cache: { size: 1234 } } };

describe('/info', () => {
  test('memory totals the bot and only live workers', () => {
    assert.equal(
      memoryLine(100 * MB, overview().processes, true),
      '100 MB bot · 250 MB total (bot + 2 workers)'
    );
    assert.equal(memoryLine(100 * MB, overview().processes, false), '100 MB');
  });

  test('queue says paused or running with both counts, or that jobs run in the bot', () => {
    assert.equal(queueLine(overview(), true), 'running · 1 running, 3 waiting');
    assert.equal(queueLine(overview({ paused: true }), true), 'paused · 1 running, 3 waiting');
    assert.equal(queueLine(overview(), false), 'jobs run in the bot');
  });

  test('durations read as minutes, hours or days', () => {
    assert.equal(formatDuration(5 * 60_000), '5m');
    assert.equal(formatDuration(72 * 60_000), '1h 12m');
    assert.equal(formatDuration(26 * 3600_000), '1d 2h');
  });

  test('the embed shows every line and never a process id or storage numbers', () => {
    const text = infoEmbed({
      botStartTime: Date.now() - 72 * 60_000,
      client,
      overview: overview(),
      workersEnabled: true,
      botRss: 100 * MB,
      inviteUrl: 'https://discord.gg/example',
    }).data.description;
    for (const k of ['version', 'memory', 'uptime', 'queue', 'host', 'runtime', 'servers']) {
      assert.match(text, new RegExp(`\\*\\*${k}\\*\\* `));
    }
    assert.match(text, /1h 12m · discord connected 1h 5m/);
    assert.match(text, /\*\*servers\*\* 1,234/);
    assert.match(text, /\[support server\]\(https:\/\/discord\.gg\/example\)/);
    assert.doesNotMatch(text, /abc123def456|r2|gifs|videos/i);
  });

  test('without an invite url only the source link is shown', () => {
    const text = infoEmbed({
      botStartTime: null,
      client,
      overview: overview(),
      workersEnabled: true,
      botRss: MB,
      inviteUrl: '',
    }).data.description;
    assert.doesNotMatch(text, /support server/);
    assert.match(text, /\[source code\]\(https:\/\/github\.com\/gronkanium\/gronka\)$/);
  });
});
