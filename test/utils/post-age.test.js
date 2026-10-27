import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { isFreshPost } from '../../src/utils/post-age.js';

describe('isFreshPost', () => {
  test('reads the creation time out of X and TikTok post ids', () => {
    const xPostedAt = Number((2114961286618562683n >> 22n) + 1288834974657n);
    const x = 'https://x.com/a/status/2114961286618562683?s=20';
    assert.equal(isFreshPost(x, xPostedAt + 3 * 60_000), true);
    assert.equal(isFreshPost(x, xPostedAt + 120 * 60_000), false);

    const tiktokPostedAt = Number(7700193649274998049n >> 32n) * 1000;
    const tiktok = 'https://www.tiktok.com/@a/video/7700193649274998049';
    assert.equal(isFreshPost(tiktok, tiktokPostedAt + 59_000), true);
    assert.equal(isFreshPost(tiktok, tiktokPostedAt + 60 * 60_000), false);
  });

  test('a link without a time-coded id is never fresh', () => {
    assert.equal(isFreshPost('https://vm.tiktok.com/ZGdCt3Nva/'), false);
    assert.equal(isFreshPost('https://www.youtube.com/watch?v=123'), false);
    assert.equal(isFreshPost('https://x.com.evil.example/a/status/2114961286618562683'), false);
  });
});
