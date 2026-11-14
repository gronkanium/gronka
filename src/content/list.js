import { createLogger } from '../utils/logger.js';
import { describeCause } from '../utils/errors.js';
import { collectionOf } from '../utils/collections.js';
import { post, thread } from './schema.js';
import { fetchPageThread } from './page.js';

const logger = createLogger('content-list');

export const LIST_LIMITS = { entries: 100 };

export const isListContentUrl = url => collectionOf(url) !== null;

// The list comes from the same listing /download uses; the page only adds its title, cover and blurb.
export async function fetchListThread(
  url,
  { readPage = fetchPageThread, collection = collectionOf(url) } = {}
) {
  const { kind, list } = collection;
  const [page, listed] = await Promise.all([
    readPage(url).catch(error => {
      logger.warn(`List page unreadable, answering with the listing: ${describeCause(error)}`);
      return null;
    }),
    list(LIST_LIMITS.entries),
  ]);
  const entries = listed.entries.slice(0, LIST_LIMITS.entries);
  const total = Math.max(listed.total ?? 0, listed.entries.length);
  const subject = page?.post ?? post({ url });
  return thread({
    source: 'list',
    url,
    post: {
      ...subject,
      url,
      title: listed.title ?? subject.title,
      extra: { ...subject.extra, kind, total, entries },
    },
    truncated: total > entries.length,
  });
}
