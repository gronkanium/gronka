import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { isMangaDexChapterUrl, isMangaDexTitleUrl } from '../../src/utils/gallery-dl.js';

describe('manga URL detection', () => {
  test('recognizes MangaDex title URLs', () => {
    assert.equal(
      isMangaDexTitleUrl(
        'https://mangadex.org/title/2cf5ac51-8ad6-46a5-a921-2e2f26b5fcf1/class-no-tenshi'
      ),
      true
    );
  });

  test('does not classify chapters or lookalike hosts as title URLs', () => {
    assert.equal(
      isMangaDexTitleUrl('https://mangadex.org/chapter/147eedae-c0dc-47a5-81ae-013cfef68a42'),
      false
    );
    assert.equal(
      isMangaDexTitleUrl(
        'https://mangadex.org.evil.example/title/2cf5ac51-8ad6-46a5-a921-2e2f26b5fcf1'
      ),
      false
    );
  });

  test('recognizes MangaDex chapter URLs for the same page-range flow', () => {
    assert.equal(
      isMangaDexChapterUrl('https://mangadex.org/chapter/147eedae-c0dc-47a5-81ae-013cfef68a42'),
      true
    );
    assert.equal(isMangaDexChapterUrl('https://mangadex.org/title/not-a-uuid'), false);
  });
});
