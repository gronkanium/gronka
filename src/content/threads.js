import { isThreadsUrl, fetchThreadsPost, threadsPostCode } from '../utils/threads.js';
import { normalizeInstagramItem } from './instagram.js';
import { post, thread } from './schema.js';

export const THREADS_LIMITS = {};

export const isThreadsContentUrl = isThreadsUrl;

// A Threads post is an Instagram media record on another domain.
export function normalizeThreadsPost(item, code) {
  const base = normalizeInstagramItem(item, code);
  const handle = base.author.handle;
  const info = item.text_post_app_info ?? {};
  return post({
    ...base,
    url: handle ? `https://www.threads.com/@${handle}/post/${code}` : null,
    author: { ...base.author, url: handle ? `https://www.threads.com/@${handle}` : null },
    stats: {
      ...base.stats,
      replies: info.direct_reply_count ?? base.stats.replies,
      reposts: info.repost_count ?? null,
    },
    extra: { ...base.extra, quotes: info.quote_count ?? null },
  });
}

export async function fetchThreadsThread(url, { read = fetchThreadsPost } = {}) {
  const subject = normalizeThreadsPost(await read(url), threadsPostCode(url));
  return thread({ source: 'threads', url: subject.url ?? url, post: subject });
}
