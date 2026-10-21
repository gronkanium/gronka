import { describe, test, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import assert from 'node:assert';
import axios from 'axios';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchRedditListing } from '../../src/utils/reddit.js';
import { downloadFromDeviantArt } from '../../src/utils/deviantart.js';

describe('session cookies never travel over http', () => {
  let dir;
  let saved;
  let spy;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookies-'));
    const file = path.join(dir, 'cookies.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ reddit: ['reddit_session=r'], deviantart: ['auth_secure=d'] })
    );
    saved = process.env.INSTAGRAM_COOKIES_PATH;
    process.env.INSTAGRAM_COOKIES_PATH = file;
  });
  afterEach(() => spy?.mockRestore());
  afterAll(() => {
    if (saved === undefined) delete process.env.INSTAGRAM_COOKIES_PATH;
    else process.env.INSTAGRAM_COOKIES_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const requested = async run => {
    const urls = [];
    spy = spyOn(axios, 'get').mockImplementation(async url => {
      urls.push(url);
      throw new Error('stop');
    });
    await run().catch(() => {});
    return urls;
  };

  test('reddit', async () => {
    const urls = await requested(() =>
      fetchRedditListing('http://www.reddit.com/r/pics/comments/abc/title/')
    );
    assert.ok(urls.length > 0);
    for (const url of urls) assert.match(url, /^https:\/\//);
  });

  test('deviantart', async () => {
    const urls = await requested(() =>
      downloadFromDeviantArt('http://www.deviantart.com/u/art/title-123')
    );
    assert.ok(urls.length > 0);
    for (const url of urls) assert.match(url, /^https:\/\//);
  });
});
