// How many items of one post or chapter are fetched or stored at once.
export const ITEM_FANOUT = 4;

// Like Promise.all over items.map(fn), but at most `limit` run at once; stops starting new ones after a failure.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
