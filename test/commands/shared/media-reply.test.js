import { describe, onTestFinished, test } from 'bun:test';
import assert from 'node:assert/strict';
import { AttachmentBuilder } from 'discord.js';
import {
  mediaReplyPayload,
  mediaReplyBatches,
  formatSizeChange,
} from '../../../src/commands/shared/media-reply.js';
import { r2ExpiryText } from '../../../src/utils/r2-storage.js';
import { r2Config } from '../../../src/utils/config.js';

describe('media replies', () => {
  test('a file goes as a bare attachment, no embed and no text', () => {
    const attachment = new AttachmentBuilder(Buffer.from('gif'), { name: 'gronka.gif' });
    const payload = mediaReplyPayload([{ size: 3, type: 'gif', attachment }]);
    assert.deepEqual(payload, { content: '', files: [attachment] });
  });

  test('a link goes as plain text so Discord shows its own player', () => {
    const url = 'https://example.com/video.mp4';
    const payload = mediaReplyPayload([{ url, type: 'video' }]);
    assert.deepEqual(payload, { content: url });
  });

  test('a size change rides along as a small text line', () => {
    const attachment = new AttachmentBuilder(Buffer.from('gif'), { name: 'gronka.gif' });
    const payload = mediaReplyPayload([{ attachment, description: formatSizeChange(1000, 750) }]);
    assert.equal(payload.embeds, undefined);
    assert.match(payload.content, /^-# .*25\.0% smaller\)$/);
  });

  test('temporary links get one expiry note for the longest lifetime', () => {
    const saved = { ...r2Config };
    Object.assign(r2Config, { cleanupEnabled: true, publicDomain: 'cdn.test' });
    onTestFinished(() => Object.assign(r2Config, saved));
    const items = [
      { url: 'https://cdn.test/videos/a.mp4', ttlHours: 6 },
      { url: 'https://cdn.test/videos/b.mp4', ttlHours: 48 },
    ];
    const lines = mediaReplyPayload(items).content.split('\n');
    assert.deepEqual(lines.slice(0, 2), [items[0].url, items[1].url]);
    assert.equal(lines.length, 3);
    assert.match(lines[2], /^-# this link will expire in 2 days/);
  });

  test('expiry is promised only for our own links while cleanup runs', () => {
    const config = { cleanupEnabled: true, publicDomain: 'files.example.com' };
    const url = 'https://files.example.com/videos/a.mp4';
    assert.match(r2ExpiryText(url, config, 6), /6 hours/);
    assert.match(r2ExpiryText(url, config, 48), /2 days/);
    assert.equal(r2ExpiryText(url, { ...config, cleanupEnabled: false }, 6), null);
    assert.equal(r2ExpiryText('https://other.example.com/a.mp4', config, 6), null);
  });

  test('reports reductions, increases, and unchanged sizes honestly', () => {
    assert.match(formatSizeChange(1000, 750), /25.0% smaller/);
    assert.match(formatSizeChange(1000, 1250), /25.0% larger/);
    assert.match(formatSizeChange(1000, 1000), /unchanged/);
    assert.doesNotMatch(formatSizeChange(0, 1000), /Infinity|NaN/);
  });

  test('batches every link within Discord limits without dropping any', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ url: `https://example.com/${i}.mp4` }));
    assert.deepEqual(
      mediaReplyBatches(items).map(b => b.length),
      [10, 10, 3]
    );
    const long = items.map(item => ({ url: item.url + '?q=' + 'a'.repeat(700) }));
    const batches = mediaReplyBatches(long);
    assert.deepEqual(batches.flat(), long);
    for (const batch of batches) assert.ok(mediaReplyPayload(batch).content.length <= 2000);
  });
});
