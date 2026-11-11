import { test } from 'bun:test';
import assert from 'node:assert';
import { parseProfileEdit } from '../../src/utils/bot-profile.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('only the fields sent are changed, and null removes an avatar or banner', () => {
  assert.deepStrictEqual(parseProfileEdit({ username: ' gronka ', avatar: PNG, banner: null }), {
    user: { username: 'gronka', avatar: PNG, banner: null },
    bio: undefined,
  });
  assert.deepStrictEqual(parseProfileEdit({ bio: '' }), { user: {}, bio: '' });
});

test('refuses anything but an image for the avatar or banner, and an empty edit', () => {
  assert.throws(() => parseProfileEdit({ avatar: 'https://example.com/a.png' }), /avatar/);
  assert.throws(() => parseProfileEdit({ banner: 'data:text/html;base64,PGI+' }), /banner/);
  assert.throws(() => parseProfileEdit({ username: '  ' }), /username/);
  assert.throws(() => parseProfileEdit({ bio: 5 }), /bio/);
  assert.throws(() => parseProfileEdit({}), /nothing to change/);
});
