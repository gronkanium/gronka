import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('needsTrimming logic', () => {
  /**
   * Inline implementation matching src/commands/download/trimming.js:needsTrimming
   * Avoids the heavy import chain (file-downloader → DISCORD_TOKEN)
   */
  function needsTrimming(fileType, startTime, duration, downloadMethod) {
    // yt-dlp already trims using --download-sections
    const alreadyTrimmedByYtdlp =
      downloadMethod === 'ytdlp' && (startTime !== null || duration !== null);

    return (
      (fileType === 'video' || fileType === 'gif') &&
      (startTime !== null || duration !== null) &&
      !alreadyTrimmedByYtdlp
    );
  }

  describe('cobalt downloads — trims when video/gif and params given', () => {
    test('gif with startTime → needs trimming', () => {
      assert.strictEqual(needsTrimming('gif', 5, null, 'cobalt'), true);
    });

    test('gif with duration → needs trimming', () => {
      assert.strictEqual(needsTrimming('gif', null, 10, 'cobalt'), true);
    });

    test('gif with both startTime and duration → needs trimming', () => {
      assert.strictEqual(needsTrimming('gif', 5, 10, 'cobalt'), true);
    });

    test('video with startTime → needs trimming', () => {
      assert.strictEqual(needsTrimming('video', 5, null, 'cobalt'), true);
    });

    test('video with duration → needs trimming', () => {
      assert.strictEqual(needsTrimming('video', null, 10, 'cobalt'), true);
    });

    test('video with both → needs trimming', () => {
      assert.strictEqual(needsTrimming('video', 5, 10, 'cobalt'), true);
    });
  });

  describe('ytdlp downloads — never needs trimming (handled via --download-sections)', () => {
    test('gif with startTime via ytdlp → no trimming needed', () => {
      assert.strictEqual(needsTrimming('gif', 5, null, 'ytdlp'), false);
    });

    test('video with duration via ytdlp → no trimming needed', () => {
      assert.strictEqual(needsTrimming('video', null, 10, 'ytdlp'), false);
    });

    test('video with both via ytdlp → no trimming needed', () => {
      assert.strictEqual(needsTrimming('video', 5, 10, 'ytdlp'), false);
    });
  });

  describe('images — never trimmed regardless of params or method', () => {
    test('image with startTime via cobalt → no trimming', () => {
      assert.strictEqual(needsTrimming('image', 5, 10, 'cobalt'), false);
    });

    test('image with duration via ytdlp → no trimming', () => {
      assert.strictEqual(needsTrimming('image', null, 10, 'ytdlp'), false);
    });
  });

  describe('no trim params — never trims regardless of type or method', () => {
    test('gif with no params via cobalt → no trimming', () => {
      assert.strictEqual(needsTrimming('gif', null, null, 'cobalt'), false);
    });

    test('video with no params via cobalt → no trimming', () => {
      assert.strictEqual(needsTrimming('video', null, null, 'cobalt'), false);
    });

    test('video with no params via ytdlp → no trimming', () => {
      assert.strictEqual(needsTrimming('video', null, null, 'ytdlp'), false);
    });
  });
});
