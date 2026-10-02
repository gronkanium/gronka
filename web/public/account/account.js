import { $, esc, api, turnstileToken, warmTurnstile, icon, save, ApiError } from '/common.js';

const view = $('#view');
const show = html => {
  view.innerHTML = html;
  view.querySelector('h1, h2')?.setAttribute('tabindex', '-1');
};
const err = (where, error) => {
  where.innerHTML = `<p class="err ink" role="alert">${esc(error.message)}</p>`;
};
const on = (sel, fn) => $(sel)?.addEventListener('click', fn);
const busy = async (button, fn) => {
  button.disabled = true;
  try {
    await fn();
  } finally {
    if (button.isConnected) button.disabled = false;
  }
};
// Runs fn with the button disabled and prints any error into msg; `cancelled` replaces a dismissed browser prompt.
const act = (button, msg, fn, cancelled) =>
  busy(button, async () => {
    try {
      await fn();
    } catch (error) {
      err($(msg), cancelled && error.name === 'NotAllowedError' ? { message: cancelled } : error);
    }
  });
const onAct = (sel, msg, fn, cancelled) =>
  on(sel, event => act(event.currentTarget, msg, fn, cancelled));

const b64url = buf =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64url = text =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const passkeys = !!window.PublicKeyCredential;
// The session cookie is HttpOnly on api.gronka.dev, so this only saves a pointless 401 on a first visit.
const HINT = 'gw-signed-in';
const hint = on => {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    // storage blocked, the account request decides instead
  }
};
const hinted = () => {
  try {
    return localStorage.getItem(HINT) !== null;
  } catch {
    return true;
  }
};

function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON)
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: unb64url(json.challenge),
    user: { ...json.user, id: unb64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map(c => ({ ...c, id: unb64url(c.id) })),
  };
}

function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON)
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return {
    ...json,
    challenge: unb64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map(c => ({ ...c, id: unb64url(c.id) })),
  };
}

function credentialJson(cred) {
  if (cred.toJSON) return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: b64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  } else {
    Object.assign(response, {
      authenticatorData: b64url(r.authenticatorData),
      signature: b64url(r.signature),
    });
    if (r.userHandle) response.userHandle = b64url(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
  };
}

let totpOn = false;
const codeDialog = document.createElement('dialog');
codeDialog.className = 'code-ask ink';
codeDialog.innerHTML = `<form method="dialog">
  <label class="label" for="ask-code"></label>
  <span class="ink field"><input id="ask-code" autocomplete="one-time-code" inputmode="text" spellcheck="false" maxlength="11" /></span>
  <div class="acts"><button class="btn" value="ok">continue</button>
  <button class="btn line small" value="cancel" formnovalidate>cancel</button></div></form>`;
document.body.append(codeDialog);

const ask = wrong =>
  new Promise(resolve => {
    codeDialog.querySelector('label').textContent = wrong
      ? 'wrong code. try again.'
      : '2fa is on. enter an authenticator code or a recovery code.';
    const input = codeDialog.querySelector('input');
    input.value = '';
    codeDialog.returnValue = '';
    codeDialog.addEventListener(
      'close',
      () =>
        resolve(codeDialog.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null),
      { once: true }
    );
    codeDialog.showModal();
    input.focus();
  });

// Sensitive actions need a current 2fa code when 2fa is on; the server says so if we guessed wrong.
async function withCode(call) {
  let code = totpOn ? await ask(false) : '';
  for (let tries = 0; ; tries++) {
    if (code === null) throw new ApiError('CANCELLED', 'cancelled.', 0);
    try {
      return await call(code ? { code } : {});
    } catch (error) {
      if (tries < 3 && ['TOTP_REQUIRED', 'TOTP_INVALID'].includes(error.code)) {
        code = await ask(error.code === 'TOTP_INVALID');
        continue;
      }
      throw error;
    }
  }
}

async function addPasskey() {
  const options = await withCode(body =>
    api('/v1/passkeys/register/options', { method: 'POST', body })
  );
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  const label = /iphone|ipad|mac/i.test(navigator.userAgent)
    ? 'apple device'
    : /android/i.test(navigator.userAgent)
      ? 'android'
      : 'this device';
  await api('/v1/passkeys/register', {
    method: 'POST',
    body: { response: credentialJson(cred), label },
  });
}

function kit(number) {
  const date = new Date().toISOString().slice(0, 10);
  return new Blob(
    [
      `gronka account number\n\n${number}\n\nmade ${date} on https://web.gronka.dev/account/\n\n` +
        'this number gets you into your gronka account. it holds your api keys.\n' +
        'there is no reset. lose it without a passkey and the account is gone.\n' +
        'an account never used is deleted after 90 days; once used, after a year without use.\n' +
        'keep this file somewhere safe, like a password manager.\n',
    ],
    { type: 'text/plain' }
  );
}

function saveNumber(number, next, { rotated = false } = {}) {
  show(`<img class="peng" src="/p/idle.svg" alt="" width="400" height="400" />
    <h1>${rotated ? 'your new number.' : 'your account number.'}</h1>
    <p>this number gets you back in. <strong>no email. no reset.</strong> lose it without a passkey and the account is gone${rotated ? ', and the old number already stopped working' : ''}.</p>
    <p class="meta">an account you never use is deleted after 90 days; once used, after a year without use.</p>
    <p class="number ink" id="num">${esc(number)}</p>
    <div class="acts"><button type="button" class="btn" id="dl">${icon('download')}download it</button>
    <button type="button" class="btn line small" id="copy">${icon('copy')}copy</button></div>
    <div class="acts"><button type="button" class="btn line" id="next">continue</button></div>`);
  $('h1').focus();
  on('#dl', () => save(kit(number), 'gronka-account.txt'));
  on('#copy', async () => {
    await navigator.clipboard.writeText(number);
    $('#copy').lastChild.textContent = 'copied';
  });
  on('#next', next);
}

function offerPasskey() {
  if (!passkeys) return dashboard();
  show(`<img class="peng" src="/p/think.svg" alt="" width="400" height="400" />
    <h1>add a passkey?</h1>
    <p>a passkey is another way in, kept by your phone, laptop or password manager. if you lose the number but keep the passkey, you can log in and make a new one.</p>
    <div class="acts"><button type="button" class="btn" id="add">${icon('passkey')}add a passkey</button>
    <button type="button" class="linkish" id="skip">not now</button></div><div id="msg"></div>`);
  $('h1').focus();
  onAct(
    '#add',
    '#msg',
    async () => {
      await addPasskey();
      dashboard();
    },
    'cancelled. you can add one later.'
  );
  on('#skip', dashboard);
}

function signedOut() {
  show(`<h1>account</h1>
    <p class="lede">for api keys. the page doesn't need one. no email or username, just an account number.</p>
    <div class="cards">
      <div class="card ink"><h2>new here</h2><p>make an account. save the number. it shows once.</p>
        <button type="button" class="btn" id="create">make an account</button><div id="create-msg"></div></div>
      <form class="card ink" id="login" novalidate><h2>have a number</h2>
        <label class="label" for="number">account number</label>
        <span class="ink field"><input id="number" autocomplete="username" spellcheck="false" autocapitalize="characters" placeholder="GW ..." /></span>
        <div id="totp-wrap" hidden><label class="label" for="totp">code from your authenticator app, or a recovery code</label>
        <span class="ink field"><input id="totp" autocomplete="one-time-code" inputmode="text" spellcheck="false" /></span></div>
        <button type="submit" class="btn" id="login-go">log in</button>
        ${passkeys ? `<p class="or">or</p><button type="button" class="btn line" id="pk">${icon('passkey')}log in with a passkey</button>` : ''}
        <div id="login-msg"></div></form>
    </div>`);
  const warm = () => (warmTurnstile('account'), warmTurnstile('login'));
  view.addEventListener('focusin', warm, { once: true });
  view.addEventListener('pointerdown', warm, { once: true });
  onAct('#create', '#create-msg', async () => {
    const turnstile = await turnstileToken('account');
    const { number } = await api('/v1/account', { method: 'POST', body: { turnstile } });
    saveNumber(number, offerPasskey);
  });
  $('#login').addEventListener('submit', event => {
    event.preventDefault();
    busy($('#login-go'), async () => {
      try {
        const turnstile = await turnstileToken('login');
        const body = { number: $('#number').value, turnstile };
        if ($('#totp').value.trim()) body.totp = $('#totp').value.trim();
        await api('/v1/session', { method: 'POST', body });
        dashboard();
      } catch (error) {
        if (error.code === 'TOTP_REQUIRED') {
          $('#totp-wrap').hidden = false;
          $('#totp').focus();
        }
        err($('#login-msg'), error);
      }
    });
  });
  onAct(
    '#pk',
    '#login-msg',
    async () => {
      const turnstile = await turnstileToken('login');
      const { challengeId, options } = await api('/v1/passkeys/login/options', {
        method: 'POST',
        body: { turnstile },
      });
      const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
      await api('/v1/passkeys/login', {
        method: 'POST',
        body: { challengeId, response: credentialJson(cred) },
      });
      dashboard();
    },
    'that was cancelled or no passkey was found.'
  );
}

const when = (label, day) => (day ? `${label} ${day}` : '');

async function dashboard(notice = '') {
  let me;
  try {
    me = await api('/v1/account');
    hint(true);
  } catch (error) {
    if (error.code === 'UNAUTHORIZED') {
      hint(false);
      return signedOut();
    }
    return (
      show(`<h1>account</h1><img class="peng" src="/p/failed.svg" alt="" width="400" height="400" /><p>${esc(error.message)}</p>
      <div class="acts"><button type="button" class="btn" id="retry">try again</button></div>`),
      on('#retry', () => dashboard())
    );
  }
  show(`<h1>account</h1><p class="meta mono">GW ${esc(me.id)} · made ${esc(me.createdOn)}</p><div id="notice">${notice}</div>
    <section aria-labelledby="h-keys"><h2 id="h-keys">api keys</h2>
      <p>send one as <span class="mono">Authorization: Bearer gk_...</span> to skip the cloudflare check. same limits as everyone. <a href="/docs/">how</a>.</p>
      <ul class="list">${
        me.keys
          .map(
            k => `<li><span><span class="what">${esc(k.id)}</span> ${esc(k.label ?? '')}<br><span class="when">${when('made', k.createdOn)} ${when('· last used', k.lastUsedOn) || '· never used'}</span></span>
        <button type="button" class="btn line small" data-revoke="${esc(k.id)}">${icon('x')}revoke</button></li>`
          )
          .join('') || '<li class="note">no keys yet.</li>'
      }</ul>
      <form class="row" id="newkey" novalidate><label class="field-wrap"><span class="label">label, optional</span><span class="ink field"><input id="label" maxlength="40" autocomplete="off" /></span></label>
        <button class="btn" type="submit" ${me.keys.length >= 10 ? 'disabled' : ''}>${icon('key')}new key</button></form><div id="key-out"></div></section>
    <section aria-labelledby="h-2fa"><h2 id="h-2fa">2fa <span class="pill ${me.totp ? '' : 'off'}">${me.totp ? 'on' : 'off'}</span></h2><div id="totp-box"></div></section>
    <section aria-labelledby="h-pk"><h2 id="h-pk">passkeys</h2>
      ${passkeys ? '' : '<p class="note">this browser does not support passkeys.</p>'}
      <ul class="list">${
        me.passkeys
          .map(
            p => `<li><span>${icon('passkey')} ${esc(p.label ?? 'passkey')}<br><span class="when">${when('added', p.createdOn)}</span></span>
        <button type="button" class="btn line small" data-unpk="${esc(p.id)}">${icon('x')}remove</button></li>`
          )
          .join('') || '<li class="note">none yet. a passkey gives you another way in.</li>'
      }</ul>
      ${passkeys ? `<button type="button" class="btn line small" id="addpk">${icon('passkey')}add a passkey</button>` : ''}<div id="pk-msg"></div></section>
    <section aria-labelledby="h-num"><h2 id="h-num">account number</h2>
      <p>if the old number leaked, make a new one. the old number stops working at once, and other sessions are signed out. keys, passkeys and 2fa stay.</p>
      <button type="button" class="btn line small" id="rotate">new number</button><div id="rot-msg"></div></section>
    <section aria-labelledby="h-out"><h2 id="h-out">leave</h2>
      <div class="acts"><button type="button" class="btn line small" id="logout">log out</button></div>
      <p>delete the account and all its keys and passkeys right away. there is no undo.</p>
      <div class="row"><label><span class="label">type delete to confirm</span><span class="ink field"><input id="confirm" autocomplete="off" /></span></label>
      <button type="button" class="btn" id="delete" disabled>delete account</button></div><div id="del-msg"></div></section>`);
  $('h1').focus();

  $('#newkey').addEventListener('submit', event => {
    event.preventDefault();
    act(event.target.querySelector('button'), '#key-out', async () => {
      const { id, key } = await api('/v1/keys', {
        method: 'POST',
        body: { label: $('#label').value },
      });
      await dashboard(`<p class="note">new key <span class="mono">${esc(id)}</span>. copy it now, it is shown once:</p>
        <p class="number key ink">${esc(key)}</p><div class="acts"><button type="button" class="btn small" id="copykey" data-key="${esc(key)}">${icon('copy')}copy key</button></div>`);
      on('#copykey', async () => {
        await navigator.clipboard.writeText($('#copykey').dataset.key);
        $('#copykey').lastChild.textContent = 'copied';
      });
    });
  });
  view.querySelectorAll('[data-revoke]').forEach(button =>
    button.addEventListener('click', () =>
      busy(button, async () => {
        await api(`/v1/keys/${button.dataset.revoke}`, { method: 'DELETE' });
        dashboard(
          `<p class="note">revoked ${esc(button.dataset.revoke)}. it stopped working just now.</p>`
        );
      })
    )
  );
  view.querySelectorAll('[data-unpk]').forEach(button =>
    button.addEventListener('click', () =>
      act(button, '#pk-msg', async () => {
        await withCode(body =>
          api(`/v1/passkeys/${encodeURIComponent(button.dataset.unpk)}`, { method: 'DELETE', body })
        );
        dashboard('<p class="note">passkey removed.</p>');
      })
    )
  );
  onAct(
    '#addpk',
    '#pk-msg',
    async () => {
      await addPasskey();
      dashboard('<p class="note">passkey added.</p>');
    },
    'that was cancelled.'
  );
  onAct('#rotate', '#rot-msg', async () => {
    if (!confirm('make a new account number? the current one stops working right away.')) return;
    const { number } = await withCode(body => api('/v1/account/rotate', { method: 'POST', body }));
    saveNumber(
      number,
      () => dashboard('<p class="note">new number saved. the old one is dead.</p>'),
      { rotated: true }
    );
  });
  on('#logout', async () => {
    await api('/v1/session', { method: 'DELETE' }).catch(() => {});
    hint(false);
    signedOut();
  });
  $('#confirm').addEventListener('input', event => {
    $('#delete').disabled = event.target.value.trim().toLowerCase() !== 'delete';
  });
  onAct('#delete', '#del-msg', async () => {
    await withCode(body => api('/v1/account', { method: 'DELETE', body }));
    hint(false);
    show(
      '<h1>gone.</h1><img class="peng" src="/p/done.svg" alt="" width="400" height="400" /><p>the account and everything in it are gone.</p><p><a href="/">back to downloading</a></p>'
    );
  });
  totpOn = me.totp;
  totpBox(me);
}

function codesBlock(codes) {
  return `<p>recovery codes. each works once, in place of a code, if you lose your authenticator. <strong>shown once.</strong></p>
    <ul class="codes ink">${codes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    <div class="acts"><button type="button" class="btn small" id="dlcodes">${icon('download')}download codes</button></div>`;
}

function showCodes(box, codes, before = '') {
  box.innerHTML = `${before}${codesBlock(codes)}<button type="button" class="linkish" id="done2fa">done</button>`;
  on('#dlcodes', () =>
    save(
      new Blob([`gronka recovery codes\n\n${codes.join('\n')}\n\neach works once.\n`], {
        type: 'text/plain',
      }),
      'gronka-recovery-codes.txt'
    )
  );
  on('#done2fa', () => dashboard());
}

function totpBox(me) {
  const box = $('#totp-box');
  const codeForm = (
    id,
    label,
    button
  ) => `<form class="row" id="${id}" novalidate><label><span class="label">${label}</span>
    <span class="ink field"><input name="code" autocomplete="one-time-code" spellcheck="false" /></span></label><button class="btn small" type="submit">${button}</button></form><div id="${id}-msg"></div>`;
  const submit = (id, fn) =>
    $(`#${id}`).addEventListener('submit', event => {
      event.preventDefault();
      act(event.target.querySelector('button'), `#${id}-msg`, () =>
        fn(event.target.code.value.trim())
      );
    });

  if (!me.totp) {
    box.innerHTML = `<p>use an authenticator code with your number or passkey.</p><button type="button" class="btn line small" id="setup">turn on 2fa</button><div id="setup-msg"></div>`;
    onAct('#setup', '#setup-msg', async () => {
      const { uri, secret } = await api('/v1/totp/setup', { method: 'POST', body: {} });
      box.innerHTML = `<p>add this to your authenticator app. on your phone, <a href="${esc(uri)}">open it in the app</a>, or type the key:</p>
        <p class="number key ink mono">${esc(secret.match(/.{1,4}/g).join(' '))}</p>${codeForm('enable', 'the 6-digit code it shows', 'turn on')}`;
      submit('enable', async code => {
        const { recoveryCodes } = await api('/v1/totp/enable', { method: 'POST', body: { code } });
        showCodes(box, recoveryCodes, '<p class="note">2fa is on.</p>');
      });
    });
    return;
  }
  box.innerHTML = `<p>${me.recoveryCodesLeft} recovery code${me.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
    ${codeForm('regen', 'authenticator or recovery code, for new recovery codes', 'new codes')}${codeForm('off', 'authenticator or recovery code, to turn 2fa off', 'turn off')}`;
  submit('regen', async code => {
    const { recoveryCodes } = await api('/v1/totp/recovery', { method: 'POST', body: { code } });
    showCodes(box, recoveryCodes);
  });
  submit('off', async code => {
    await api('/v1/totp', { method: 'DELETE', body: { code } });
    dashboard('<p class="note">2fa is off.</p>');
  });
}

if (hinted()) dashboard();
else signedOut();
