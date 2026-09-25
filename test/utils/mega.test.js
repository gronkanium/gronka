import { describe, test } from 'bun:test';
import assert from 'node:assert';
import crypto from 'crypto';
import {
  parseMegaUrl,
  keylessMegaFileId,
  megaKeys,
  decryptMegaAttributes,
} from '../../src/utils/mega.js';
import { isDirectMediaUrl } from '../../src/utils/file-downloader.js';

const KEY = 'M0_bBx49HYqVvZG_kROyYrgCI6KyFkxsaEyGSAgjVpg';

describe('mega utilities', () => {
  test('parses new and legacy file links and rejects everything else', () => {
    assert.strictEqual(parseMegaUrl(`https://mega.nz/file/XdcWEbjR#${KEY}`).id, 'XdcWEbjR');
    assert.strictEqual(parseMegaUrl(`https://mega.nz/#!XdcWEbjR!${KEY}`).id, 'XdcWEbjR');
    assert.strictEqual(parseMegaUrl(`https://mega.nz/file/XdcWEbjR#${KEY}`).key.length, 32);
    assert.strictEqual(parseMegaUrl('https://mega.nz/file/XdcWEbjR'), null);
    assert.strictEqual(parseMegaUrl(`https://mega.nz/folder/XdcWEbjR#${KEY}`), null);
    assert.strictEqual(parseMegaUrl(`https://mega.nz.evil.example/file/XdcWEbjR#${KEY}`), null);
    assert.strictEqual(isDirectMediaUrl(`https://mega.nz/file/XdcWEbjR#${KEY}`), true);
  });

  test('finds the file id of a link shared without its key', () => {
    assert.strictEqual(keylessMegaFileId('https://mega.nz/file/knxWQB4B'), 'knxWQB4B');
    assert.strictEqual(keylessMegaFileId('https://mega.nz/file/knxWQB4B#'), 'knxWQB4B');
    assert.strictEqual(keylessMegaFileId('https://mega.nz/#!knxWQB4B'), 'knxWQB4B');
    assert.strictEqual(keylessMegaFileId(`https://mega.nz/file/knxWQB4B#${KEY}`), null);
    assert.strictEqual(keylessMegaFileId('https://mega.nz/folder/knxWQB4B'), null);
    assert.strictEqual(keylessMegaFileId('https://example.com/file/knxWQB4B'), null);
  });

  test('round-trips attributes and file bytes through the derived keys', () => {
    const key = Buffer.from(KEY, 'base64url');
    const { aesKey, iv } = megaKeys(key);

    const attrs = Buffer.from('MEGA{"n":"clip.mov"}');
    const padded = Buffer.concat([attrs, Buffer.alloc(16 - (attrs.length % 16))]);
    const cbc = crypto.createCipheriv('aes-128-cbc', aesKey, Buffer.alloc(16));
    cbc.setAutoPadding(false);
    const at = Buffer.concat([cbc.update(padded), cbc.final()]).toString('base64url');
    assert.deepStrictEqual(decryptMegaAttributes(at, aesKey), { n: 'clip.mov' });

    const wrongKey = megaKeys(Buffer.alloc(32, 1)).aesKey;
    assert.throws(() => decryptMegaAttributes(at, wrongKey));

    const plain = Buffer.from('\0\0\0\x14ftypqt  payload');
    const enc = crypto.createCipheriv('aes-128-ctr', aesKey, iv).update(plain);
    assert.deepStrictEqual(crypto.createDecipheriv('aes-128-ctr', aesKey, iv).update(enc), plain);
  });
});
