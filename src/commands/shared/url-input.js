import { AppError } from '../../utils/errors.js';
import { downloadFileFromUrl, parseTenorUrl, TENOR_VIEW_URL } from '../../utils/file-downloader.js';

// The file behind a url option, as {attachment, file, originalUrl}.
export async function fetchUrlInput(url, client) {
  let source = url;
  if (TENOR_VIEW_URL.test(url)) {
    try {
      source = await parseTenorUrl(url);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('failed to parse Tenor URL.');
    }
  }
  const file = await downloadFileFromUrl(source, client);
  return {
    attachment: {
      url: source,
      name: file.filename,
      size: file.size,
      contentType: file.contentType,
    },
    file,
    originalUrl: source,
  };
}
