import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'bun:test';
import { createZip } from '../../src/utils/archive.js';

const execFileAsync = promisify(execFile);

describe('zip archives', () => {
  test('creates a readable archive with each page in order', async () => {
    const archive = createZip([
      { filename: 'page-1.jpg', buffer: Buffer.from('one') },
      { filename: 'page-2.jpg', buffer: Buffer.from('two') },
    ]);
    const file = `/tmp/gronka-archive-${Date.now()}.zip`;
    await fs.writeFile(file, archive);
    const { stdout } = await execFileAsync('unzip', ['-Z1', file]);
    assert.equal(stdout, 'page-1.jpg\npage-2.jpg\n');
    await fs.unlink(file);
  });

  test('keeps sanitized duplicate filenames distinct', async () => {
    const archive = createZip([
      { filename: 'page one.jpg', buffer: Buffer.from('one') },
      { filename: 'page_one.jpg', buffer: Buffer.from('two') },
    ]);
    const file = `/tmp/gronka-archive-duplicates-${Date.now()}.zip`;
    await fs.writeFile(file, archive);
    const { stdout } = await execFileAsync('unzip', ['-Z1', file]);
    assert.equal(stdout, 'page_one.jpg\npage_one-1.jpg\n');
    await fs.unlink(file);
  });
});
