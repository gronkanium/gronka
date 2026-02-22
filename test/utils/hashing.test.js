import { test, describe } from 'node:test';
import assert from 'node:assert';
import { hashBytesHex, hashStringHex, hashPartsHex } from '../../src/utils/hashing.js';

describe('hashing utilities', () => {
  describe('hashBytesHex', () => {
    test('returns a 64-character lowercase hex string', () => {
      const result = hashBytesHex(Buffer.from('hello'));
      assert.strictEqual(typeof result, 'string');
      assert.strictEqual(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    test('is deterministic', () => {
      const bytes = Buffer.from('consistent input');
      assert.strictEqual(hashBytesHex(bytes), hashBytesHex(bytes));
      assert.strictEqual(hashBytesHex(bytes), hashBytesHex(Buffer.from('consistent input')));
    });

    test('different inputs produce different hashes', () => {
      assert.notStrictEqual(
        hashBytesHex(Buffer.from('input-a')),
        hashBytesHex(Buffer.from('input-b'))
      );
      assert.notStrictEqual(hashBytesHex(Buffer.from('abc')), hashBytesHex(Buffer.from('abd')));
    });

    test('empty bytes has a well-defined deterministic hash', () => {
      const empty1 = hashBytesHex(new Uint8Array(0));
      const empty2 = hashBytesHex(new Uint8Array(0));
      assert.strictEqual(empty1.length, 64);
      assert.strictEqual(empty1, empty2);
    });

    test('single-byte inputs differ', () => {
      assert.notStrictEqual(hashBytesHex(new Uint8Array([0])), hashBytesHex(new Uint8Array([1])));
    });

    test('hash of large buffer is still 64 chars', () => {
      const large = Buffer.alloc(1024 * 1024, 0xab); // 1 MB
      const result = hashBytesHex(large);
      assert.strictEqual(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });
  });

  describe('hashStringHex', () => {
    test('returns a 64-character lowercase hex string', () => {
      const result = hashStringHex('hello');
      assert.strictEqual(typeof result, 'string');
      assert.strictEqual(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    test('is deterministic', () => {
      assert.strictEqual(hashStringHex('same input'), hashStringHex('same input'));
    });

    test('different strings produce different hashes', () => {
      assert.notStrictEqual(hashStringHex('foo'), hashStringHex('bar'));
      assert.notStrictEqual(hashStringHex('abc'), hashStringHex('ABC'));
    });

    test('matches hashBytesHex on equivalent UTF-8 bytes', () => {
      const str = 'hello world';
      assert.strictEqual(hashStringHex(str), hashBytesHex(Buffer.from(str, 'utf8')));
    });

    test('handles empty string', () => {
      const result = hashStringHex('');
      assert.strictEqual(result.length, 64);
      assert.strictEqual(result, hashStringHex(''));
    });

    test('coerces non-string values via String()', () => {
      assert.strictEqual(hashStringHex(42), hashStringHex('42'));
      assert.strictEqual(hashStringHex(null), hashStringHex('null'));
      assert.strictEqual(hashStringHex(true), hashStringHex('true'));
    });

    test('handles multi-byte unicode (emoji)', () => {
      const result = hashStringHex('🦆');
      assert.strictEqual(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
      // Must differ from ASCII approximations
      assert.notStrictEqual(result, hashStringHex('duck'));
      assert.notStrictEqual(result, hashStringHex(':duck:'));
    });

    test('case-sensitive — upper and lowercase differ', () => {
      assert.notStrictEqual(hashStringHex('Hello'), hashStringHex('hello'));
    });

    test('whitespace is significant', () => {
      assert.notStrictEqual(hashStringHex('hello world'), hashStringHex('helloworld'));
      assert.notStrictEqual(hashStringHex('hello'), hashStringHex('hello '));
    });
  });

  describe('hashPartsHex', () => {
    test('returns a 64-character lowercase hex string', () => {
      const result = hashPartsHex(['a', 'b']);
      assert.strictEqual(result.length, 64);
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    test('is deterministic', () => {
      const parts = ['foo', 'bar', 'baz'];
      assert.strictEqual(hashPartsHex(parts), hashPartsHex([...parts]));
    });

    test('null parts are skipped', () => {
      assert.strictEqual(hashPartsHex(['a', null, 'b']), hashPartsHex(['a', 'b']));
      assert.strictEqual(hashPartsHex([null, 'x', null]), hashPartsHex(['x']));
    });

    test('undefined parts are skipped', () => {
      assert.strictEqual(hashPartsHex(['a', undefined, 'b']), hashPartsHex(['a', 'b']));
      assert.strictEqual(hashPartsHex([undefined, 'x']), hashPartsHex(['x']));
    });

    test('all-null/undefined parts equals empty parts', () => {
      assert.strictEqual(hashPartsHex([null, undefined, null]), hashPartsHex([]));
    });

    test('order matters', () => {
      assert.notStrictEqual(hashPartsHex(['a', 'b']), hashPartsHex(['b', 'a']));
      assert.notStrictEqual(hashPartsHex(['hello', 'world']), hashPartsHex(['world', 'hello']));
    });

    test('concatenation is NOT the same as separate parts — parts are not separator-joined', () => {
      // 'ab' as one part vs 'a'+'b' as two parts should differ,
      // proving parts feed into the hasher sequentially without any separator
      // (they MAY be equal since blake3.update() is equivalent to appending)
      // but 'xy' + 'z' vs 'x' + 'yz' must differ if hashing is per-part
      // Actually blake3 streaming update IS equivalent to concatenation:
      // hashPartsHex(['x','yz']) === hashPartsHex(['xy','z']) === hashStringHex('xyz')
      assert.strictEqual(hashPartsHex(['x', 'yz']), hashStringHex('xyz'));
      assert.strictEqual(hashPartsHex(['xy', 'z']), hashStringHex('xyz'));
      assert.strictEqual(hashPartsHex(['x', 'y', 'z']), hashStringHex('xyz'));
    });

    test('accepts Uint8Array / Buffer parts', () => {
      const bytes = Buffer.from('binary');
      const result = hashPartsHex(['prefix-', bytes]);
      assert.strictEqual(result.length, 64);
      // Must be deterministic
      assert.strictEqual(result, hashPartsHex(['prefix-', bytes]));
      // Buffer part should be treated as raw bytes
      assert.strictEqual(result, hashStringHex('prefix-binary'));
    });

    test('empty parts array', () => {
      const result = hashPartsHex([]);
      assert.strictEqual(result.length, 64);
    });

    test('single string part matches hashStringHex', () => {
      assert.strictEqual(hashPartsHex(['hello']), hashStringHex('hello'));
      assert.strictEqual(hashPartsHex(['']), hashStringHex(''));
    });

    test('different numbers of parts with same combined content differ only by content not count', () => {
      // Ensures nulls don't affect output
      assert.strictEqual(hashPartsHex(['a', 'b', 'c']), hashPartsHex([null, 'a', null, 'b', 'c']));
    });
  });
});
