import { test, describe, beforeAll, afterAll, mock } from 'bun:test';
import assert from 'node:assert';
import * as realChildProcess from 'child_process';

// mock.module() is process-global, so it is registered only in the one-process-per-file e2e run.
const mocksSupported = process.env.GRONKA_E2E === 'true';

if (!mocksSupported) {
  describe('soundcloudTrack', () => {
    test.skip('module mocks are e2e-only (run via bun run test:e2e)', () => {});
  });
} else {
  let soundcloudTrack;
  let ytdlpJson;
  let calls;

  beforeAll(async () => {
    const childProcessMock = () => ({
      ...realChildProcess,
      execFile: (cmd, args, options, callback) => {
        calls.push(args);
        callback(null, { stdout: JSON.stringify(ytdlpJson), stderr: '' });
      },
    });
    mock.module('child_process', childProcessMock);
    mock.module('node:child_process', childProcessMock);
    ({ soundcloudTrack } = await import('../../src/utils/soundcloud.js'));
  });

  afterAll(() => mock.restore());

  describe('soundcloudTrack', () => {
    test('a set link reads its first track instead of calling the set drm-only', async () => {
      calls = [];
      ytdlpJson = {
        _type: 'playlist',
        title: 'Sounds of the Sea',
        entries: [
          {
            title: 'Coral Sea Sonification',
            uploader: 'NASA',
            duration: 60,
            formats: [{ format_id: 'http_mp3_1_0' }],
          },
        ],
      };
      const track = await soundcloudTrack('https://soundcloud.com/nasa/sets/sounds-of-the-sea');
      assert.strictEqual(track.title, 'Coral Sea Sonification');
      assert.strictEqual(track.drm, false);
      assert.strictEqual(calls[0][calls[0].indexOf('--playlist-items') + 1], '1');
    });
  });
}
