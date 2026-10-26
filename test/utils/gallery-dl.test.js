import { describe, test } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { galleryDlError, downloadWithGalleryDl } from '../../src/utils/gallery-dl.js';
import { withJobDir } from '../../src/utils/media-file.js';
import { ValidationError } from '../../src/utils/errors.js';

describe('galleryDlError', () => {
  test('files skipped for size say the file is too large', () => {
    const error = galleryDlError(
      '[downloader.http][warning] File size larger than allowed maximum (90000000 > 10485760)\n',
      'Imgur'
    );
    assert.ok(error instanceof ValidationError);
    assert.strictEqual(error.message, 'a gallery file is too large to download');
  });

  test('a missing post is CONTENT_GONE and keeps the reason from gallery-dl', () => {
    const error = galleryDlError(
      "[artstation][warning] '404 Not Found' for 'https://www.artstation.com/projects/x.json'\n[artstation][error] NotFoundError: Requested user could not be found\n",
      'ArtStation'
    );
    assert.strictEqual(error.code, 'CONTENT_GONE');
    assert.strictEqual(
      error.cause.message,
      'gallery-dl: NotFoundError: Requested user could not be found'
    );
  });

  test('a TikTok post that is gone is CONTENT_GONE', () => {
    const error = galleryDlError(
      '[tiktok][error] https://www.tiktok.com/@a/video/7686889905351314719: Requested post not available\n'
    );
    assert.strictEqual(error.code, 'CONTENT_GONE');
  });

  test('an unnamed site never reads as "this this site"', () => {
    const error = galleryDlError('[x][error] SomethingOdd: boom\n');
    assert.strictEqual(error.message, 'could not download this post');
  });

  test('a login wall says so, naming the site', () => {
    const error = galleryDlError(
      "[rule34][error] AuthRequired: 'api-key' & 'user-id' needed to access the API\n",
      'Rule34'
    );
    assert.ok(error instanceof ValidationError);
    assert.strictEqual(error.message, 'Rule34 only shows this to logged in accounts.');
  });

  test('a bot challenge reads as a block, not a missing post', () => {
    const error = galleryDlError(
      "[flickr][error] ChallengeError: Cloudflare challenge (403 Forbidden) for 'https://flickr.com/'\n",
      'Flickr'
    );
    assert.strictEqual(error.message, 'Flickr is blocking downloads right now, try again later');
  });

  test('a rate-limited file download reads as a rate limit', () => {
    const error = galleryDlError(
      "[downloader.http][warning] '429 Too Many Requests' for 'https://live.staticflickr.com/x_o.jpg'\n[download][error] Failed to download flickr_1.jpg\n",
      'Flickr'
    );
    assert.strictEqual(
      error.message,
      'Flickr is rate limiting downloads right now, try again in a few minutes.'
    );
  });

  test('an empty run with no output says there was nothing to download', () => {
    const error = galleryDlError('', 'Wallhaven');
    assert.strictEqual(error.message, 'this Wallhaven link has no image or video to download.');
    assert.strictEqual(error.cause.message, 'gallery-dl: no files and no output');
  });
});

describe('downloadWithGalleryDl', () => {
  const fakeGalleryDl = async pages => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-gallery-dl-'));
    const script = `#!/bin/sh
while [ "$1" != "--directory" ]; do shift; done
for i in $(seq 1 ${pages}); do printf 'page' > "$2/page_$i.jpg"; done
`;
    await fs.writeFile(path.join(bin, 'gallery-dl'), script, { mode: 0o755 });
    return bin;
  };
  const withFake = async (pages, fn) => {
    const bin = await fakeGalleryDl(pages);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      return await withJobDir(fn);
    } finally {
      process.env.PATH = saved;
      await fs.rm(bin, { recursive: true, force: true });
    }
  };

  test('a gallery over the loose-file limit comes back as one zip, pages in order', async () => {
    await withFake(30, async () => {
      const zip = await downloadWithGalleryDl('https://nhentai.net/g/1/');
      assert.strictEqual(zip.archive, true);
      const entries = [
        ...(await fs.readFile(zip.path)).toString('latin1').matchAll(/page_\d+\.jpg/g),
      ]
        .map(m => m[0])
        .slice(0, 30);
      assert.deepStrictEqual(entries.slice(0, 3), ['page_1.jpg', 'page_2.jpg', 'page_3.jpg']);
      assert.strictEqual(entries[29], 'page_30.jpg');
    });
  });

  test('a small gallery still comes back as loose files', async () => {
    await withFake(3, async () => {
      const files = await downloadWithGalleryDl('https://nhentai.net/g/1/');
      assert.strictEqual(files.length, 3);
    });
  });
});
