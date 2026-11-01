import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  isGoogleDriveUrl,
  googleDriveFileId,
  googleDriveDownloadUrl,
} from '../../src/utils/google-drive.js';

const id = '1LuUURO_7J7stf0u59TH7NykJLvnA-uoO';

describe('Google Drive file links', () => {
  test('reads the file id from every public file link form', () => {
    for (const url of [
      `https://drive.google.com/file/d/${id}/view?usp=sharing`,
      `https://drive.google.com/file/d/${id}`,
      `https://drive.google.com/file/u/0/d/${id}/view`,
      `https://drive.google.com/open?id=${id}`,
      `https://drive.google.com/uc?id=${id}&export=download`,
      `https://drive.usercontent.google.com/download?id=${id}`,
    ]) {
      assert.equal(googleDriveFileId(url), id, url);
    }
  });

  test('rejects folders, other google pages and lookalike hosts', () => {
    for (const url of [
      `https://drive.google.com/drive/folders/${id}`,
      'https://drive.google.com/file/d/short/view',
      `https://docs.google.com/document/d/${id}/edit`,
      `https://drive.google.com.evil.example/file/d/${id}/view`,
      `https://www.google.com/open?id=${id}`,
      `ftp://drive.google.com/file/d/${id}/view`,
      'invalid',
    ]) {
      assert.equal(isGoogleDriveUrl(url), false, url);
    }
  });

  test('downloads through the usercontent host, past the large-file virus check page', () => {
    assert.equal(
      googleDriveDownloadUrl(`https://drive.google.com/file/d/${id}/view?usp=drive_link`),
      `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    );
  });
});
