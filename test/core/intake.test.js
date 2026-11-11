import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readLink, prepareLink, refusalFor } from '../../src/core/intake.js';

describe('link intake', () => {
  test('readLink finds the link in pasted text and refuses unsafe or missing ones', () => {
    assert.equal(readLink('look at this x.com/a/status/1!').url, 'https://x.com/a/status/1');
    assert.equal(readLink('', 'none here').refusal.message, 'none here');
    assert.equal(readLink('http://127.0.0.1/a.mp4').refusal.reason, 'invalid_url');
  });

  test('text that is not a link is told so, and the record keeps the old reason', () => {
    for (const text of ['@ari: mind yall', 'd7277a17-7530-4167.gif', '<Pink']) {
      const { refusal } = readLink(text);
      assert.equal(refusal.message, "that's not a link. paste the whole link to the post.");
      assert.equal(refusal.detail, 'invalid URL: invalid URL format');
      assert.equal(refusal.reason, 'invalid_url');
    }
    assert.equal(
      readLink('http://localhost/a.mp4').refusal.message,
      'invalid URL: localhost and loopback addresses are not allowed'
    );
  });

  test('prepareLink folds mirrors onto the real site', async () => {
    assert.equal(
      await prepareLink('https://fxtwitter.com/a/status/1'),
      'https://twitter.com/a/status/1'
    );
  });

  test('refusalFor takes routed links and names why it refuses the rest', async () => {
    assert.equal(await refusalFor('https://www.youtube.com/watch?v=abc'), null);
    assert.equal(
      (await refusalFor('https://discord.com/channels/1/2/3')).reason,
      'discord_message_link'
    );
    assert.equal((await refusalFor('https://example.com/page')).reason, 'invalid_social_media_url');
  });
});
