import { describe, test } from 'bun:test';
import assert from 'node:assert';
import {
  conversionInfo,
  compatibleFormats,
  conversionTrim,
  gifSettings,
} from '../../src/utils/conversion-options.js';

const metadata = (streams, format_name = 'mov,mp4,m4a,3gp,3g2,mj2') => ({
  streams,
  format: { format_name, duration: '6' },
});
const video = { codec_type: 'video', index: 0, width: 64, height: 64 };
const audio = { codec_type: 'audio', index: 1 };

describe('conversion compatibility', () => {
  test('a silent MP4 offers video, GIF and still frames, without audio extraction', () => {
    const info = conversionInfo(metadata([video]));
    assert.strictEqual(info.kind, 'video');
    assert.deepStrictEqual(compatibleFormats(info).sort(), [
      'gif',
      'jpg',
      'mp4',
      'png',
      'webm',
      'webp',
    ]);
  });

  test('video with sound offers every current output', () => {
    const info = conversionInfo(metadata([video, audio]));
    assert.deepStrictEqual(compatibleFormats(info).sort(), [
      'flac',
      'gif',
      'jpg',
      'm4a',
      'mp3',
      'mp4',
      'ogg',
      'png',
      'wav',
      'webm',
      'webp',
    ]);
  });

  test('embedded artwork does not turn an audio file into video', () => {
    const info = conversionInfo(metadata([{ ...video, disposition: { attached_pic: 1 } }, audio]));
    assert.strictEqual(info.kind, 'audio');
    assert.deepStrictEqual(compatibleFormats(info).sort(), ['flac', 'm4a', 'mp3', 'ogg', 'wav']);
  });

  test('multiple audio tracks use the marked default', () => {
    const info = conversionInfo(
      metadata([video, audio, { codec_type: 'audio', index: 2, disposition: { default: 1 } }])
    );
    assert.strictEqual(info.audioIndex, 2);
  });

  test('still images offer image formats and GIF', () => {
    const info = conversionInfo(metadata([video], 'png_pipe'));
    assert.strictEqual(info.kind, 'image');
    assert.deepStrictEqual(compatibleFormats(info).sort(), ['gif', 'jpg', 'png', 'webp']);
  });

  test('GIF animation offers video and labeled still-frame outputs', () => {
    const info = conversionInfo(metadata([video], 'gif'));
    assert.strictEqual(info.kind, 'animation');
    assert.ok(compatibleFormats(info).includes('mp4'));
    assert.ok(!compatibleFormats(info).includes('mp3'));
  });

  test('a file without usable media streams is rejected', () => {
    assert.throws(
      () => conversionInfo(metadata([{ codec_type: 'subtitle' }])),
      /no usable audio or video/
    );
  });

  test('audio and animations accept valid trim ranges', () => {
    for (const kind of ['audio', 'animation']) {
      assert.deepStrictEqual(conversionTrim({ kind, duration: 6 }, { startTime: 1, duration: 3 }), {
        startTime: 1,
        duration: 3,
      });
    }
  });

  test('start-only and end-only trims cannot exceed the source', () => {
    assert.throws(
      () => conversionTrim({ kind: 'audio', duration: 6 }, { startTime: 6 }),
      /outside/
    );
    assert.throws(() => conversionTrim({ kind: 'video', duration: 6 }, { duration: 7 }), /outside/);
  });

  test('still-image timestamps are rejected instead of silently ignored', () => {
    assert.throws(() => conversionTrim({ kind: 'image' }, { startTime: 1 }), /still image/);
  });

  test('an end time of zero is rejected before encoding an empty file', () => {
    assert.throws(
      () => conversionTrim({ kind: 'audio', duration: 6 }, { duration: 0 }),
      /after the start/
    );
  });
});

describe('gif settings', () => {
  const portrait = { width: 1080, height: 1440, fps: 60 };

  test('a short clip keeps the 640px, 20fps defaults', () => {
    const settings = gifSettings({}, { ...portrait, duration: 10 });
    assert.strictEqual(settings.width, 640);
    assert.strictEqual(settings.fps, 20);
  });

  test('a long clip steps fps then width down to stay encodable', () => {
    const settings = gifSettings({}, { ...portrait, duration: 143.5 });
    assert.strictEqual(settings.fps, 12);
    assert.ok(settings.width < 640 && settings.width >= 320, `width ${settings.width}`);
  });

  test('a trim is what gets budgeted, not the whole file', () => {
    const settings = gifSettings({ startTime: 0, duration: 10 }, { ...portrait, duration: 3600 });
    assert.strictEqual(settings.width, 640);
  });

  test('explicit width and fps are kept', () => {
    const settings = gifSettings({ width: 600, fps: 15 }, { ...portrait, duration: 60 });
    assert.strictEqual(settings.width, 600);
    assert.strictEqual(settings.fps, 15);
  });

  test('a clip too long even at the floor is refused up front', () => {
    assert.throws(
      () => gifSettings({}, { ...portrait, duration: 3600 }),
      /too long to make into a gif/
    );
  });

  test('an unprobed file falls back to the defaults', () => {
    const settings = gifSettings({}, { width: 480, height: null, fps: 30, duration: null });
    assert.strictEqual(settings.width, 480);
    assert.strictEqual(settings.fps, 20);
  });
});
