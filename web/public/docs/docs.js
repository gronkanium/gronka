document.querySelectorAll('.copy').forEach(button => {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code').textContent;
    const status = document.querySelector('#copy-status');
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = 'copied';
      button.textContent = 'copied';
      window.setTimeout(() => {
        button.textContent = 'copy';
      }, 1400);
    } catch {
      const pre = button.parentElement.querySelector('pre');
      const range = document.createRange();
      range.selectNodeContents(pre);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      pre.focus();
      status.textContent = 'code selected. copy it with your keyboard.';
    }
  });
});

document.querySelectorAll('.mobile-toc a').forEach(link => {
  link.addEventListener('click', () => {
    link.closest('details').open = false;
  });
});
