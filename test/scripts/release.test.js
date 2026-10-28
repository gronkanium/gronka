import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { nextVersion, changelogEntries, renderNotes } from '../../scripts/release.js';

const day = new Date('2026-10-28T12:00:00Z');

describe('nextVersion', () => {
  test('first release of the day is the date', () => {
    assert.strictEqual(nextVersion(day, ['v4.10.0', 'v2026.10.27']), '2026.10.28');
  });

  test('later releases that day get a suffix', () => {
    assert.strictEqual(nextVersion(day, ['v2026.10.28']), '2026.10.28.1');
    assert.strictEqual(nextVersion(day, ['v2026.10.28', 'v2026.10.28.1']), '2026.10.28.2');
  });

  test('pads month and day', () => {
    assert.strictEqual(nextVersion(new Date('2027-01-05T00:00:00Z'), []), '2027.01.05');
  });
});

describe('changelogEntries', () => {
  test('takes type, scope and PR from the subject', () => {
    const [e] = changelogEntries([
      { sha: 'a'.repeat(40), message: 'fix(download): Tumblr reblogs (#196)' },
    ]);
    assert.deepStrictEqual(
      { type: e.type, scope: e.scope, text: e.text, pr: e.pr, breaking: e.breaking },
      { type: 'fix', scope: 'download', text: 'Tumblr reblogs', pr: '196', breaking: undefined }
    );
  });

  test('a squash body listing conventional subjects replaces the subject', () => {
    const message =
      'fix: one input path (#194)\n\n* fix(convert): fetch inputs once\n\nNote: prose\n\n* feat(convert): accept AVIF images';
    const entries = changelogEntries([{ sha: 'b'.repeat(40), message }]);
    assert.deepStrictEqual(
      entries.map(e => `${e.type}:${e.text}`),
      ['fix:fetch inputs once', 'feat:accept AVIF images']
    );
  });

  test('marks breaking changes from ! and the footer', () => {
    const bang = changelogEntries([{ sha: 'c'.repeat(40), message: 'feat!: drop MEDIA_WORKERS' }]);
    const footer = changelogEntries([
      { sha: 'd'.repeat(40), message: 'feat: new env\n\nBREAKING CHANGE: R2_BUCKET is required' },
    ]);
    assert.strictEqual(bang[0].breaking, 'drop MEDIA_WORKERS');
    assert.strictEqual(footer[0].breaking, 'R2_BUCKET is required');
  });
});

describe('renderNotes', () => {
  test('groups visible types and hides the rest', () => {
    const notes = renderNotes(
      changelogEntries([
        { sha: 'e'.repeat(40), message: 'ci: bump actions' },
        { sha: 'f'.repeat(40), message: 'deps(deps): bump qs (#201)' },
        { sha: '1'.repeat(40), message: 'feat!: dated versions' },
      ])
    );
    assert.match(notes, /^### ⚠ BREAKING CHANGES\n\n\* dated versions/);
    assert.match(notes, /### Features\n\n\* dated versions \(\[1111111\]/);
    assert.match(notes, /### Dependencies\n\n\* \*\*deps:\*\* bump qs \(\[#201\]/);
    assert.doesNotMatch(notes, /bump actions/);
  });

  test('is empty when nothing user-facing changed', () => {
    assert.strictEqual(
      renderNotes(changelogEntries([{ sha: '2'.repeat(40), message: 'chore: tidy' }])),
      ''
    );
  });
});
