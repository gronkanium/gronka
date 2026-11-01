import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  infoEmbed,
  memoryLine,
  queueLine,
  formatDuration,
  uptimeLine,
} from '../../src/commands/info.js';

const MB = 1024 ** 2;
const proc = (role, rss, live = true) => ({ id: `abc123def456-${rss}`, role, rss: rss * MB, live });
const overview = (extra = {}) => ({
  paused: false,
  counts: { queued: 3, running: 1 },
  processes: [proc('bot', 90), proc('worker', 70), proc('worker', 80), proc('worker', 500, false)],
  ...extra,
});
const client = { uptime: 65 * 60_000, guilds: { cache: { size: 1234 } } };
const fields = embed => Object.fromEntries(embed.data.fields.map(f => [f.name, f.value]));

describe('/info', () => {
  test('memory totals the bot and only live workers', () => {
    assert.equal(
      memoryLine(100 * MB, overview().processes, true),
      '100 MB bot\n250 MB with 2 workers'
    );
    assert.equal(memoryLine(100 * MB, overview().processes, false), '100 MB');
  });

  test('queue reads idle, paused or the counts', () => {
    assert.equal(queueLine(overview(), true), '1 running · 3 waiting');
    assert.equal(queueLine(overview({ paused: true }), true), 'paused · 1 running · 3 waiting');
    assert.equal(queueLine(overview({ counts: { queued: 0, running: 0 } }), true), 'idle');
    assert.equal(
      queueLine(overview({ paused: true, counts: { queued: 0, running: 0 } }), true),
      'paused'
    );
    assert.equal(queueLine(overview(), false), 'jobs run in the bot');
  });

  test('durations read as minutes, hours or days', () => {
    assert.equal(formatDuration(5 * 60_000), '5m');
    assert.equal(formatDuration(72 * 60_000), '1h 12m');
    assert.equal(formatDuration(26 * 3600_000), '1d 2h');
  });

  test('uptime mentions the gateway only after a reconnect', () => {
    assert.equal(uptimeLine(72 * 60_000, 72 * 60_000 - 5000), '1h 12m');
    assert.equal(uptimeLine(72 * 60_000, 65 * 60_000), '1h 12m\nconnected 1h 5m');
  });

  test('the embed shows every field and never a process id or storage numbers', () => {
    const embed = infoEmbed({
      botStartTime: Date.now() - 72 * 60_000,
      client,
      overview: overview(),
      workersEnabled: true,
      botRss: 100 * MB,
      inviteUrl: 'https://discord.gg/example',
    });
    const f = fields(embed);
    assert.deepEqual(Object.keys(f), [
      'servers',
      'uptime',
      'queue',
      'memory',
      'version',
      'runtime',
    ]);
    assert.equal(f.servers, '1,234');
    assert.equal(f.uptime, '1h 12m\nconnected 1h 5m');
    assert.match(
      f.version,
      /^\[v[\d.]+\]\(https:\/\/github\.com\/gronkanium\/gronka\/releases\/tag\/v[\d.]+\)$/
    );
    assert.match(embed.data.description, /\[support server\]\(https:\/\/discord\.gg\/example\)/);
    assert.match(embed.data.footer.text, /cpus$/);
    assert.doesNotMatch(JSON.stringify(embed.data), /abc123def456|r2|gifs|videos/i);
  });

  test('without an invite url only the site and source links are shown', () => {
    const text = infoEmbed({
      botStartTime: null,
      client,
      overview: overview(),
      workersEnabled: true,
      botRss: MB,
      inviteUrl: '',
    }).data.description;
    assert.doesNotMatch(text, /support server/);
    assert.match(
      text,
      /\[gronka\.dev\]\(https:\/\/gronka\.dev\) · \[source code\]\(https:\/\/github\.com\/gronkanium\/gronka\)$/
    );
  });
});
