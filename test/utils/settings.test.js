import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readSetting, SETTINGS } from '../../src/utils/settings.js';
import { setSetting } from '../../src/utils/database.js';

describe('readSetting', () => {
  test('returns stored values parsed to their type, defaults when unreadable', async () => {
    await setSetting('max_video_duration', '1200');
    assert.equal(await readSetting('max_video_duration'), 1200);
    await setSetting('max_video_duration', 'nonsense');
    assert.equal(
      await readSetting('max_video_duration'),
      Number(SETTINGS.max_video_duration.default)
    );
    await setSetting('disabled_services', '{"not":"a list"}');
    assert.deepEqual(await readSetting('disabled_services'), []);
    await setSetting('url_only_mode', 'true');
    assert.equal(await readSetting('url_only_mode'), true);
  });

  test('refuses keys that are not in the schema', async () => {
    await assert.rejects(readSetting('no_such_setting'), /unknown setting/);
  });

  test('every setting names a label and section', () => {
    for (const [key, meta] of Object.entries(SETTINGS)) {
      assert.ok(meta.label && meta.section && typeof meta.default === 'string', key);
    }
  });
});
