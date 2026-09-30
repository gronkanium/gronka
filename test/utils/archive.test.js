import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'bun:test';
import { writeZip } from '../../src/utils/archive.js';
import { mediaFromBytes } from '../helpers/media.js';

const execFileAsync = promisify(execFile);
const page = (filename, text) => mediaFromBytes(Buffer.from(text), { filename });

describe('zip archives', () => {
  test('creates a readable archive with each page in order', async () => {
    const archive = await writeZip([
      await page('page-1.jpg', 'one'),
      await page('page-2.jpg', 'two'),
    ]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', archive.path]);
    assert.equal(stdout, 'page-1.jpg\npage-2.jpg\n');
    const { stdout: second } = await execFileAsync('unzip', ['-p', archive.path, 'page-2.jpg']);
    assert.equal(second, 'two');
    assert.equal(archive.archive, true);
  });

  test('keeps sanitized duplicate filenames distinct', async () => {
    const archive = await writeZip([
      await page('page one.jpg', 'one'),
      await page('page_one.jpg', 'two'),
    ]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', archive.path]);
    assert.equal(stdout, 'page_one.jpg\npage_one-1.jpg\n');
  });
});
