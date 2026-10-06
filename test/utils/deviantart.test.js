import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { deviationId, parseState, pickMedia } from '../../src/utils/deviantart.js';

const base = 'https://images-wixmp.example/f/abc/d1.jpg';

describe('deviantart utilities', () => {
  test('reads the deviation id from art links only', () => {
    assert.strictEqual(
      deviationId('https://www.deviantart.com/a/art/Some-Title-1104077420'),
      '1104077420'
    );
    assert.strictEqual(deviationId('https://deviantart.com/a/art/1104077420/'), '1104077420');
    assert.strictEqual(deviationId('https://www.deviantart.com/a/gallery'), null);
    assert.strictEqual(deviationId('https://deviantart.com.evil.example/a/art/x-1'), null);
    assert.strictEqual(deviationId('not a url'), null);
  });

  test('decodes the page state literal, including escaped quotes', () => {
    const state = { '@@entities': { deviation: { 1: { title: `it's "x"` } } } };
    const literal = JSON.stringify(JSON.stringify(state)).slice(1, -1).replaceAll("'", "\\'");
    const html = `<script>window.__INITIAL_STATE__ = JSON.parse("${literal}");</script>`;
    assert.deepStrictEqual(parseState(html), state);
    assert.strictEqual(parseState('<html></html>'), null);
  });

  test('picks the tallest video that fits the size limit', () => {
    const deviation = {
      media: {
        types: [
          { t: 'video', h: 360, f: 10, b: 'v360' },
          { t: 'video', h: 1080, f: 100, b: 'v1080' },
          { t: 'video', h: 720, f: 50, b: 'v720' },
        ],
      },
    };
    assert.strictEqual(pickMedia(deviation), 'v1080');
    assert.strictEqual(pickMedia(deviation, 60), 'v720');
    assert.strictEqual(pickMedia(deviation, 1), 'v360');
  });

  test('builds the full-size image url and refuses blurred previews', () => {
    const media = { baseUri: base, prettyName: 'pic', token: ['tok'] };
    assert.strictEqual(
      pickMedia({ media: { ...media, types: [{ t: 'fullview' }] } }),
      `${base}?token=tok`
    );
    assert.strictEqual(
      pickMedia({
        media: { ...media, types: [{ t: 'fullview', c: '/v1/fill/w_10/<prettyName>.jpg' }] },
      }),
      `${base}/v1/fill/w_10/pic.jpg?token=tok`
    );
    assert.strictEqual(
      pickMedia({
        media: {
          ...media,
          types: [{ t: 'fullview', c: '/v1/fill/w_10,blur_51/<prettyName>.jpg' }],
        },
      }),
      null
    );
    assert.strictEqual(
      pickMedia({ media: { ...media, types: [{ t: 'preview', c: '/x' }] } }),
      null
    );
  });
});
