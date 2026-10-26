import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { checkExample, verdict } from '../../src/core/source-checks.js';
import { SOURCE_EXAMPLES } from '../../src/core/source-examples.js';
import { routeFor } from '../../src/core/sources.js';
import { DOWNLOAD_SERVICES } from '../../src/utils/download-services.js';
import { canonicalizeMirrorUrl } from '../../src/utils/cobalt.js';
import { NetworkError, withCause } from '../../src/utils/errors.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const file = (head, contentType, filename) => ({ head, contentType, filename, path: '/x' });
const reel = {
  site: 'instagram',
  url: 'https://www.instagram.com/reel/x/',
  expect: { type: 'video' },
};

describe('source checks', () => {
  test('a reel that comes back as its cover image fails', async () => {
    const acquire = async () => ({ kind: 'file', fileData: file(PNG, 'image/jpeg', 'reel.jpg') });
    const result = await checkExample(reel, { acquire });
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.got, 'image');
    assert.strictEqual(result.expected, 'video');
  });

  test('a reel that comes back as video passes', async () => {
    const acquire = async () => ({ kind: 'file', fileData: file(MP4, 'video/mp4', 'reel.mp4') });
    assert.strictEqual((await checkExample(reel, { acquire })).status, 'pass');
  });

  test('a carousel missing a slide fails on count', () => {
    assert.strictEqual(verdict({ type: 'image', count: 3 }, ['image', 'image']), 'fail');
    assert.strictEqual(verdict({ type: 'image', count: 3 }, ['image', 'image', 'image']), 'pass');
  });

  test('a deleted example reads as gone, with the reason', async () => {
    const acquire = async () => {
      throw withCause(new NetworkError('this post is unavailable', 'CONTENT_GONE'), 'yt-dlp: 404');
    };
    const result = await checkExample(reel, { acquire });
    assert.strictEqual(result.status, 'gone');
    assert.match(result.cause, /yt-dlp: 404/);
  });

  test('an extractor error fails with its cause', async () => {
    const acquire = async () => {
      throw withCause(new NetworkError('failed to reach instagram'), 'instagram HTTP 500');
    };
    const result = await checkExample(reel, { acquire });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.cause, /instagram HTTP 500/);
  });

  test('every example names a real site, routes somewhere and is listed once', () => {
    const sites = new Set(DOWNLOAD_SERVICES.map(s => s.id));
    const urls = new Set();
    for (const example of SOURCE_EXAMPLES) {
      assert.ok(sites.has(example.site), `${example.url}: unknown site ${example.site}`);
      assert.ok(routeFor(canonicalizeMirrorUrl(example.url)), `${example.url}: no route`);
      assert.ok(
        ['video', 'image', 'gif', 'audio', 'archive'].includes(example.expect.type),
        example.url
      );
      assert.ok(!urls.has(example.url), `${example.url} listed twice`);
      urls.add(example.url);
    }
  });
});
