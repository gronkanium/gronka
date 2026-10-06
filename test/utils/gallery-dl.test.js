import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { galleryDlError } from '../../src/utils/gallery-dl.js';
import { ValidationError } from '../../src/utils/errors.js';

describe('galleryDlError', () => {
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
