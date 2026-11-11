export const DRIVE_HOSTS = ['drive.google.com', 'drive.usercontent.google.com'];

export function googleDriveFileId(url) {
  try {
    const { hostname, pathname, protocol, searchParams } = new URL(url);
    if (!['http:', 'https:'].includes(protocol) || !DRIVE_HOSTS.includes(hostname)) return null;
    const id =
      pathname.match(/^\/file(?:\/u\/\d+)?\/d\/([\w-]+)/)?.[1] ??
      (/^\/(?:open|uc|download)$/.test(pathname) ? searchParams.get('id') : null);
    return /^[\w-]{10,}$/.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}

export const isGoogleDriveUrl = url => googleDriveFileId(url) !== null;

// confirm=t skips the "can't scan this file for viruses" page Drive puts in front of large files.
export const googleDriveDownloadUrl = url =>
  `https://drive.usercontent.google.com/download?id=${googleDriveFileId(url)}&export=download&confirm=t`;
