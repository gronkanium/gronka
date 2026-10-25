import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { AttachmentBuilder, PermissionsBitField } from 'discord.js';
import {
  mediaReplyPayload,
  mediaReplyBatches,
  formatSizeChange,
} from '../../../src/commands/shared/media-reply.js';
import { r2ExpiryText } from '../../../src/utils/r2-storage.js';

describe('media replies', () => {
  test('keeps files attached and previews images inside their embeds', () => {
    const attachment = new AttachmentBuilder(Buffer.from('gif'), { name: 'gronka.gif' });
    const payload = mediaReplyPayload({}, [
      { name: 'gronka.gif', size: 3, type: 'gif', attachment },
    ]);
    assert.equal(payload.files[0], attachment);
    assert.equal(payload.content, '');
    assert.equal(payload.embeds[0].title, 'gronka.gif');
    assert.equal(payload.embeds[0].image.url, 'attachment://gronka.gif');
    assert.equal(payload.embeds[0].footer, undefined);
  });

  test('links media titles without promising expiry for external links', () => {
    const url = 'https://example.com/video.mp4';
    const payload = mediaReplyPayload({}, [{ url, name: 'video.mp4', type: 'video' }]);
    assert.equal(payload.embeds[0].url, url);
    assert.equal(payload.embeds[0].footer, undefined);
    assert.equal(payload.files, undefined);
  });

  test('previews Cobalt photo links and preserves source filenames', () => {
    const item = {
      url: 'https://example.com/photo.jpg',
      type: 'photo',
      filename: 'holiday.jpg',
    };
    const payload = mediaReplyPayload({}, [item]);
    assert.equal(payload.embeds[0].title, item.filename);
    assert.deepEqual(payload.embeds[0].image, { url: item.url });
  });

  test('uses each temporary link lifetime only when cleanup is enabled', () => {
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

  test('falls back to text without losing attachments or size changes', () => {
    const attachment = new AttachmentBuilder(Buffer.from('gif'), { name: 'gronka.gif' });
    const payload = mediaReplyPayload({ appPermissions: new PermissionsBitField() }, [
      { attachment, description: formatSizeChange(1000, 1250) },
    ]);
    assert.deepEqual(payload.embeds, []);
    assert.equal(payload.files[0], attachment);
    assert.match(payload.content, /25.0% larger/);
  });

  test('batches every link within Discord limits without dropping any', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ url: `https://example.com/${i}.mp4` }));
    const batches = mediaReplyBatches({}, items);
    assert.deepEqual(
      batches.map(b => b.length),
      [10, 10, 3]
    );
    assert.deepEqual(batches.flat(), items);
    const long = items.map(item => ({ url: item.url + '?q=' + 'a'.repeat(700) }));
    const plain = mediaReplyBatches({ embedLinksAllowed: false }, long);
    assert.deepEqual(plain.flat(), long);
    for (const batch of plain)
      assert.ok(mediaReplyPayload({ embedLinksAllowed: false }, batch).content.length <= 2000);
  });
});
