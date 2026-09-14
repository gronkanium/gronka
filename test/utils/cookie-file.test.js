import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseNetscapeCookies,
  cookieNames,
  writeServiceCookie,
  readCookieFile,
  describeCookieFile,
} from '../../src/utils/cookie-file.js';

// The shape a browser extension actually exports, including the tab-separated columns and the
// #HttpOnly_ prefix some exporters use instead of a separate column.
const EXPORT = [
  '# Netscape HTTP Cookie File',
  '# This is a generated file! Do not edit.',
  '',
  '.instagram.com\tTRUE\t/\tTRUE\t1804893738\tcsrftoken\tabc123',
  '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1804893724\tsessionid\t56293383463%3Aag5ZtE4jveWWZV',
  '.instagram.com\tTRUE\t/\tTRUE\t1797117738\tds_user_id\t56293383463',
  '.reddit.com\tTRUE\t/\tTRUE\t1803666055\treddit_session\tjwt.payload.sig',
  'www.example.com\tFALSE\t/\tFALSE\t0\tunrelated\tnope',
].join('\n');

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'gronka-cookies-')), 'cookies.json');

describe('cookie-file', () => {
  test('converts a Netscape export into a cookie header string', () => {
    const { cookie, names } = parseNetscapeCookies(EXPORT, ['instagram.com']);
    assert.deepStrictEqual(names, ['csrftoken', 'sessionid', 'ds_user_id']);
    assert.ok(cookie.includes('sessionid=56293383463%3Aag5ZtE4jveWWZV'), 'value kept verbatim');
    assert.ok(cookie.startsWith('csrftoken=abc123; '), 'joined with "; "');
  });

  test('keeps only the requested domains', () => {
    assert.deepStrictEqual(parseNetscapeCookies(EXPORT, ['reddit.com']).names, ['reddit_session']);
    assert.strictEqual(parseNetscapeCookies(EXPORT, ['nowhere.com']).cookie, '');
  });

  test('a subdomain export still matches the bare domain', () => {
    const line = 'i.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tx';
    assert.deepStrictEqual(parseNetscapeCookies(line, ['instagram.com']).names, ['sessionid']);
  });

  test('a lookalike domain does not match', () => {
    const line = 'instagram.com.evil.test\tTRUE\t/\tTRUE\t0\tsessionid\tx';
    assert.deepStrictEqual(parseNetscapeCookies(line, ['instagram.com']).names, []);
  });

  test('malformed lines are counted, not thrown on', () => {
    const result = parseNetscapeCookies('not\ta\tcookie\nalso bad', ['instagram.com']);
    assert.strictEqual(result.cookie, '');
    assert.strictEqual(result.skipped, 2);
  });

  test('a value containing a tab survives', () => {
    const line = '.instagram.com\tTRUE\t/\tTRUE\t0\tweird\tva\tlue';
    assert.ok(parseNetscapeCookies(line, ['instagram.com']).cookie.endsWith('va\tlue'));
  });

  test('the last duplicate wins, as a browser resolves it', () => {
    const lines = [
      '.reddit.com\tTRUE\t/\tTRUE\t0\treddit_session\told',
      '.reddit.com\tTRUE\t/\tTRUE\t0\treddit_session\tnew',
    ].join('\n');
    assert.strictEqual(parseNetscapeCookies(lines, ['reddit.com']).cookie, 'reddit_session=new');
  });

  test('cookieNames reads an existing header string', () => {
    assert.deepStrictEqual(cookieNames('a=1; b=2;  c=3'), ['a', 'b', 'c']);
    assert.deepStrictEqual(cookieNames(''), []);
    assert.deepStrictEqual(cookieNames(undefined), []);
  });

  test('writing one service leaves the others untouched', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ twitter: ['auth_token=keepme'] }));
    writeServiceCookie(path, 'instagram', 'sessionid=new');
    const after = readCookieFile(path);
    assert.deepStrictEqual(after.twitter, ['auth_token=keepme'], 'twitter preserved');
    assert.deepStrictEqual(after.instagram, ['sessionid=new']);
  });

  test('a cookie file is written 600 — it holds live sessions', () => {
    const path = tempFile();
    writeServiceCookie(path, 'reddit', 'reddit_session=x');
    assert.strictEqual(statSync(path).mode & 0o777, 0o600);
  });

  test('an empty value removes the service rather than storing a blank', () => {
    const path = tempFile();
    writeServiceCookie(path, 'reddit', 'reddit_session=x');
    writeServiceCookie(path, 'reddit', '');
    assert.strictEqual(readCookieFile(path).reddit, undefined);
  });

  test('a missing or corrupt file reads as empty instead of throwing', () => {
    assert.deepStrictEqual(readCookieFile(join(tmpdir(), 'gronka-does-not-exist.json')), {});
    const path = tempFile();
    writeFileSync(path, 'not json at all');
    assert.deepStrictEqual(readCookieFile(path), {});
  });

  test('describeCookieFile reports what is missing and never the values', () => {
    const path = tempFile();
    writeServiceCookie(path, 'instagram', 'sessionid=secret-value; csrftoken=abc');
    const instagram = describeCookieFile(path).find(s => s.service === 'instagram');
    assert.strictEqual(instagram.status, 'incomplete');
    assert.deepStrictEqual(instagram.missing, ['ds_user_id']);
    assert.ok(!JSON.stringify(instagram).includes('secret-value'), 'values never leave the file');
  });

  test('a service with nothing installed reads as empty', () => {
    const path = tempFile();
    writeFileSync(path, '{}');
    const reddit = describeCookieFile(path).find(s => s.service === 'reddit');
    assert.strictEqual(reddit.status, 'empty');
    assert.strictEqual(reddit.configured, false);
  });
});
