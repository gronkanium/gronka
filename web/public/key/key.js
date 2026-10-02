import { $, esc, api, turnstileToken, warmTurnstile, icon } from '/common.js';

const view = $('#view');
const err = (where, error) => {
  $(where).innerHTML = `<p class="err ink" role="alert">${esc(error.message)}</p>`;
};
const busy = async (button, where, fn) => {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    err(where, error);
  } finally {
    button.disabled = false;
  }
};

view.innerHTML = `<h1 tabindex="-1">api key</h1>
  <p class="lede">for scripts using the api. the page doesn't need one. no account, no email: gronka keeps only a keyed hash of the key, so it is shown once and can't be recovered.</p>
  <div class="cards">
    <div class="card ink"><h2>new key</h2><p>save it somewhere safe, like a password manager.</p>
      <button type="button" class="btn" id="create">${icon('key')}get a key</button><div id="create-msg"></div></div>
    <form class="card ink" id="revoke" novalidate><h2>revoke a key</h2>
      <label class="label" for="old">the key</label>
      <span class="ink field"><input id="old" autocomplete="off" spellcheck="false" placeholder="gk_..." /></span>
      <button type="submit" class="btn line" id="revoke-go">revoke</button><div id="revoke-msg"></div></form>
  </div>`;

view.addEventListener('pointerdown', () => warmTurnstile('key'), { once: true });
view.addEventListener('focusin', () => warmTurnstile('key'), { once: true });

$('#create').addEventListener('click', event =>
  busy(event.currentTarget, '#create-msg', async () => {
    const turnstile = await turnstileToken('key');
    const { key } = await api('/v1/keys', { method: 'POST', body: { turnstile } });
    $('#create-msg').innerHTML = `<p class="note">copy it now, it is shown once:</p>
      <p class="number key ink">${esc(key)}</p>
      <div class="acts"><button type="button" class="btn small" id="copy">${icon('copy')}copy key</button></div>`;
    $('#copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(key);
      $('#copy').lastChild.textContent = 'copied';
    });
  })
);

$('#revoke').addEventListener('submit', event => {
  event.preventDefault();
  busy($('#revoke-go'), '#revoke-msg', async () => {
    await api('/v1/keys', { method: 'DELETE', key: $('#old').value.trim() });
    $('#old').value = '';
    $('#revoke-msg').innerHTML = '<p class="note">revoked. it stopped working at once.</p>';
  });
});
