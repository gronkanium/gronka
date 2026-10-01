// navigator.clipboard only exists in secure contexts; the webui is served over plain http on the LAN.
async function writeText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy refused');
}

// Copies to the clipboard and remembers what was copied for a moment, so a button can say so.
export function createCopier(ms = 1500) {
  let copied = $state(null);
  let timer;
  return {
    get copied() {
      return copied;
    },
    copy(text, key = true) {
      writeText(String(text)).then(
        () => {
          copied = key;
          clearTimeout(timer);
          timer = setTimeout(() => (copied = null), ms);
        },
        () => {}
      );
    },
    clear() {
      clearTimeout(timer);
      copied = null;
    },
  };
}
