// Copies to the clipboard and remembers what was copied for a moment, so a button can say so.
export function createCopier(ms = 1500) {
  let copied = $state(null);
  let timer;
  return {
    get copied() {
      return copied;
    },
    copy(text, key = true) {
      navigator.clipboard?.writeText(String(text)).catch(() => {});
      copied = key;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = null), ms);
    },
    clear() {
      clearTimeout(timer);
      copied = null;
    },
  };
}
