import { test, describe, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import { resolveShortLink } from '../../src/utils/short-links.js';

describe('resolveShortLink', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  test('follows a share.google link to the page it points at, through the ssrf guard', async () => {
    spy = spyOn(axios, 'get').mockResolvedValue({
      data: { destroy() {} },
      request: { res: { responseUrl: 'https://www.instagram.com/reel/abc/' } },
    });
    assert.strictEqual(
      await resolveShortLink('https://share.google/AbC'),
      'https://www.instagram.com/reel/abc/'
    );
    assert.ok(spy.mock.calls[0][1].lookup);
    assert.ok(spy.mock.calls[0][1].beforeRedirect);
  });

  test('leaves other hosts alone without a request', async () => {
    spy = spyOn(axios, 'get');
    assert.strictEqual(await resolveShortLink('https://example.com/a'), 'https://example.com/a');
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test('returns the original link when the request fails', async () => {
    spy = spyOn(axios, 'get').mockRejectedValue(new Error('timeout'));
    assert.strictEqual(
      await resolveShortLink('https://share.google/AbC'),
      'https://share.google/AbC'
    );
  });
});
