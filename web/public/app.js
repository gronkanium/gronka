import {
  $,
  api,
  online,
  turnstileToken,
  warmTurnstile,
  icon,
  save,
  mb,
  ApiError,
} from '/common.js';

const root = document.documentElement;
const form = $('#form');
const input = $('#url');
const panel = $('#panel');
const peng = $('#peng');
const hostLine = $('#host');
const asleep = $('#asleep');
const tsBox = $('#ts');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const SITES = [
  ['tiktok', 'tiktok'],
  ['instagram', 'instagram'],
  ['instagr.am', 'instagram'],
  ['x.com', 'x'],
  ['twitter', 'x'],
  ['youtu', 'youtube'],
  ['reddit', 'reddit'],
  ['redd.it', 'reddit'],
  ['facebook', 'facebook'],
  ['fb.watch', 'facebook'],
  ['pinterest', 'pinterest'],
  ['pin.it', 'pinterest'],
  ['bsky', 'bluesky'],
  ['imgur', 'imgur'],
  ['medal', 'medal'],
  ['klipy', 'klipy'],
  ['tumblr', 'tumblr'],
  ['streamable', 'streamable'],
  ['twitch', 'twitch'],
  ['vimeo', 'vimeo'],
  ['soundcloud', 'soundcloud'],
  ['giphy', 'giphy'],
  ['tenor', 'tenor'],
  ['mega.nz', 'mega'],
  ['threads', 'threads'],
  ['snapchat', 'snapchat'],
  ['dailymotion', 'dailymotion'],
  ['bilibili', 'bilibili'],
  ['nicovideo', 'niconico'],
  ['newgrounds', 'newgrounds'],
  ['loom.com', 'loom'],
  ['discord', 'discord'],
];

export function firstUrl(text) {
  const found =
    String(text).match(/https?:\/\/[^\s<>"']+/i)?.[0] ??
    String(text)
      .trim()
      .match(/^[\w-]+(\.[\w-]+)+\/\S*$/)?.[0];
  if (!found) return null;
  try {
    const url = new URL(/^https?:/i.test(found) ? found : `https://${found}`);
    return url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

export function siteOf(url) {
  const host = new URL(url).hostname.replace(/^(www|m|vm|vt)\./, '');
  return SITES.find(([key]) => host.includes(key))?.[1] ?? host;
}

const pose = name => {
  peng.src = `/p/${name}.svg`;
};
function setState(state, penguin) {
  root.dataset.state = state;
  pose(penguin);
}
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const draw = html => {
  panel.innerHTML = html;
  if (html)
    requestAnimationFrame(() =>
      panel.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
    );
};

let job = null;
let timer = null;
const stopTimer = () => clearInterval(timer);

function idle() {
  stopTimer();
  job?.abort();
  job = null;
  setState('idle', 'idle');
  draw('');
}

function showHost() {
  const text = input.value.trim();
  const url = firstUrl(text);
  hostLine.textContent = url
    ? `${siteOf(url)} link`
    : text
      ? "that doesn't look like a link yet"
      : '';
}

const STAGES = [
  [0, 'looking at the link'],
  [3, 'getting it from {site}'],
  [12, 'still getting it, this one is big'],
  [45, 'a big file. still going'],
];

function working(site) {
  setState('working', 'working');
  draw(`<h2>on it.</h2><p class="meta" id="stage"></p><div class="bar ink"><i id="fill"></i></div>
    <div class="acts"><button type="button" class="linkish" id="cancel">cancel</button></div>`);
  $('#cancel').onclick = idle;
  const began = Date.now();
  const tick = () => {
    const t = (Date.now() - began) / 1000;
    const text = STAGES.filter(([at]) => t >= at)
      .pop()[1]
      .replace('{site}', site);
    $('#stage').textContent = `${text}. ${Math.floor(t)} s`;
    $('#fill').style.width = `${92 * (1 - Math.exp(-t / 14))}%`;
  };
  tick();
  timer = setInterval(tick, 500);
}

const COPY = {
  BAD_URL: ['that link looks off.', 'think'],
  BAD_REQUEST: ['something about that was off.', 'think'],
  VALIDATION_ERROR: ["can't do that one.", 'failed'],
  CONTENT_GONE: ["it's gone.", 'failed'],
  DOWNLOAD_FAILED: ["couldn't get it.", 'failed'],
  NETWORK_ERROR: ["the site didn't answer.", 'failed'],
  VERIFICATION_FAILED: ["cloudflare wasn't sure about this browser.", 'think'],
  VERIFY_BLOCKED: ["the check didn't load.", 'think'],
  VERIFY_SLOW: ['the check is stuck.', 'think'],
  RATE_LIMITED: ['slow down a little.', 'slow'],
  BUSY: ["gronka's hands are full.", 'slow'],
  OFFLINE: ['gronka is asleep.', 'asleep'],
  MERGE_FAILED: ["couldn't join the video and audio.", 'failed'],
  INTERNAL: ['something broke on our side.', 'failed'],
};

function showError(error) {
  stopTimer();
  job = null;
  if (error.code === 'RATE_LIMITED' || error.code === 'BUSY') return countdown(error);
  const [title, penguin] = COPY[error.code] ?? COPY.INTERNAL;
  setState('error', penguin);
  const again = [
    'OFFLINE',
    'NETWORK_ERROR',
    'VERIFICATION_FAILED',
    'VERIFY_SLOW',
    'INTERNAL',
    'DOWNLOAD_FAILED',
  ].includes(error.code);
  draw(`<h2>${esc(title)}</h2><p class="say">${esc(error.message)}</p>
    <div class="acts">${again ? `<button type="button" class="btn" id="again">try again</button>` : ''}
    <button type="button" class="btn line" id="other">another link</button></div>`);
  $('#again')?.addEventListener('click', () => start());
  $('#other').onclick = () => {
    input.value = '';
    showHost();
    idle();
    input.focus();
  };
  panel.querySelector('button')?.focus();
}

function countdown(error) {
  const [title] = COPY[error.code];
  let left = Math.min(Math.max(error.retryAfter ?? (error.code === 'BUSY' ? 10 : 60), 1), 3600);
  const total = left;
  setState('wait', 'slow');
  draw(`<h2>${title}</h2><p class="say">${esc(error.message)}</p><p class="clock" id="clock" aria-hidden="true"></p>
    <p class="vh" id="clocktext"></p><div class="bar ink wait"><i id="fill"></i></div>
    <div class="acts"><button type="button" class="linkish" id="cancel">never mind</button></div>`);
  $('#cancel').onclick = idle;
  const tick = () => {
    const m = Math.floor(left / 60);
    $('#clock').textContent = m ? `${m}:${String(left % 60).padStart(2, '0')}` : `${left} s`;
    $('#fill').style.width = `${100 * (1 - left / total)}%`;
    if (left % 10 === 0 || left === total)
      $('#clocktext').textContent = `you can try again in ${left} seconds.`;
    if (left-- <= 0) {
      stopTimer();
      if (error.code === 'BUSY') start();
      else idle();
    }
  };
  tick();
  timer = setInterval(tick, 1000);
}

function body(split) {
  const out = { url: firstUrl(input.value), mode: form.mode.value };
  if ($('#start').value.trim()) out.start = $('#start').value.trim();
  if ($('#end').value.trim()) out.end = $('#end').value.trim();
  if (split === false) out.split = false;
  return out;
}

function prefetchLibav() {
  if (navigator.connection?.saveData) return;
  for (const file of ['libav-6.8.7.1-remux-cli.wasm.mjs', 'libav-6.8.7.1-remux-cli.wasm.wasm']) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = `/_libav/${file}`;
    document.head.append(link);
  }
  prefetchLibav.done = true;
}

async function start({ split } = {}) {
  const request = body(split);
  if (!request.url) {
    return showError(new ApiError('BAD_URL', 'paste a whole link, starting with https.', 400));
  }
  input.value = request.url;
  showHost();
  job?.abort();
  const controller = (job = new AbortController());
  setState('verifying', 'verify');
  draw(
    `<h2>one sec.</h2><p class="meta">cloudflare is checking this is a person, not a script.</p>`
  );
  if (request.mode === 'auto' && !prefetchLibav.done) prefetchLibav();
  try {
    request.turnstile = await turnstileToken('download', tsBox);
    if (controller.signal.aborted) return;
    working(siteOf(request.url));
    const result = await api('/v1/download', {
      method: 'POST',
      body: request,
      signal: controller.signal,
    });
    stopTimer();
    asleep.hidden = true;
    await deliver(result, request);
  } catch (error) {
    if (error.name !== 'AbortError' && !controller.signal.aborted) showError(error);
  }
}

const LANE_NOTE = {
  direct: site => `straight from ${site}, gronka never touched the file.`,
  worker: () => "streamed through gronka's edge, nothing stored.",
  r2: () => 'this link works for an hour, then the file is deleted.',
};

function nameOf(file, i = 0) {
  if (file.filename) return file.filename;
  try {
    const last = new URL(file.url).pathname.split('/').pop();
    if (/\.\w{2,4}$/.test(last)) return decodeURIComponent(last);
  } catch {
    // not a parseable url, fall through to a generic name
  }
  return `gronka-${i + 1}${file.type === 'image' || file.type === 'photo' ? '.jpg' : '.mp4'}`;
}

async function fetchWithProgress(url, onBytes, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, total);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

async function saveOne(file, lane, i = 0, onBytes = () => {}) {
  if (lane !== 'direct') {
    const a = document.createElement('a');
    a.href = file.url;
    a.rel = 'noreferrer';
    a.click();
    return true;
  }
  try {
    save(await fetchWithProgress(file.url, onBytes), nameOf(file, i));
    return true;
  } catch {
    // the site's cdn allows no cross-origin reads, so only opening the link works
    return false;
  }
}

const openLink = (url, text) =>
  `<a class="btn line small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

async function deliver(result, request) {
  const site = siteOf(request.url);
  if (result.merge) return merge(result, request);
  if (result.files.length > 1) return picker(result, site);
  const file = result.files[0];
  const name = nameOf(file);
  setState('done', 'done');
  draw(`<h2>got it.</h2><p class="meta">${esc(name)}${file.size ? ` · ${mb(file.size)}` : ''}</p>
    <p class="say note">${LANE_NOTE[result.lane](site)}</p><p class="meta" id="saving"></p>
    <div class="acts"><button type="button" class="btn" id="save">${icon('download')}save file</button>
    <button type="button" class="btn line small" id="copy">${icon('copy')}copy link</button>
    ${navigator.share ? `<button type="button" class="btn line small" id="share">${icon('share')}share</button>` : ''}
    <button type="button" class="linkish" id="other">another one</button></div>`);
  const saving = $('#saving');
  const run = () =>
    saveOne(file, result.lane, 0, (got, total) => {
      saving.textContent = total ? `saving ${mb(got)} of ${mb(total)}` : `saving ${mb(got)}`;
    }).then(saved => {
      if (saved) {
        saving.textContent = 'saved. check your downloads.';
        return;
      }
      saving.textContent =
        "this site won't let the page save it directly. open it and save it from there.";
      $('#save').replaceWith(
        Object.assign(document.createElement('span'), {
          innerHTML: openLink(file.url, `${icon('share')}open file`),
        })
      );
    });
  $('#save').onclick = run;
  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText(file.url);
    $('#copy').lastChild.textContent = 'copied';
  };
  $('#share')?.addEventListener('click', () =>
    navigator.share({ url: file.url, title: name }).catch(() => {})
  );
  $('#other').onclick = () => {
    input.value = '';
    showHost();
    idle();
    input.focus();
  };
  // A slow answer loses the click's user activation, and the browser would block the save.
  if (navigator.userActivation?.isActive ?? true) run();
  else $('#save').focus();
}

function picker(result, site) {
  setState('picker', 'think');
  const tiles = result.files
    .map((file, i) => {
      const type = file.type ?? '';
      const thumb = /video|gif/.test(type)
        ? `<video class="thumb" src="${esc(file.url)}#t=0.1" preload="metadata" muted playsinline></video>`
        : /image|photo/.test(type) || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(file.url)
          ? `<img class="thumb" src="${esc(file.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="thumb none">${icon('download')}</span>`;
      return `<label class="tile"><input type="checkbox" checked value="${i}" aria-label="file ${i + 1}, ${esc(nameOf(file, i))}" />
        <span class="tick">${icon('check')}</span><span class="ink">${thumb}</span>
        <span class="cap"><span>${i + 1}</span><span>${esc(nameOf(file, i).split('.').pop())}</span></span></label>`;
    })
    .join('');
  draw(`<h2>${result.files.length} files in this one.</h2><p class="say">pick the ones you want. ${LANE_NOTE[result.lane](site)}</p>
    <div class="grid" id="grid">${tiles}</div><p class="meta" id="saving"></p>
    <div class="acts"><button type="button" class="btn" id="some"></button>
    <button type="button" class="btn line small" id="all">${icon('download')}all ${result.files.length}</button>
    <button type="button" class="linkish" id="other">another one</button></div>`);
  for (const el of panel.querySelectorAll('.thumb')) {
    el.addEventListener('error', () =>
      el.replaceWith(
        Object.assign(document.createElement('span'), {
          className: 'thumb none',
          innerHTML: icon('download'),
        })
      )
    );
  }
  const boxes = [...panel.querySelectorAll('.tile input')];
  const label = () => {
    const n = boxes.filter(box => box.checked).length;
    $('#some').innerHTML = `${icon('download')}save ${n} file${n === 1 ? '' : 's'}`;
    $('#some').disabled = n === 0;
  };
  boxes.forEach(box => (box.onchange = label));
  label();
  const saveMany = async picked => {
    const failed = [];
    for (const [n, i] of picked.entries()) {
      $('#saving').textContent = `saving ${n + 1} of ${picked.length}`;
      if (!(await saveOne(result.files[i], result.lane, i))) failed.push(i);
      await new Promise(r => setTimeout(r, 700));
    }
    pose(failed.length === picked.length ? 'think' : 'done');
    $('#saving').innerHTML = failed.length
      ? `${failed.length === picked.length ? 'this site' : `${failed.length} of these`} won't let the page save directly. open and save:
        <span class="acts">${failed.map(i => openLink(result.files[i].url, `open ${i + 1}`)).join('')}</span>`
      : 'saved. check your downloads.';
  };
  $('#some').onclick = () =>
    saveMany(boxes.filter(box => box.checked).map(box => Number(box.value)));
  $('#all').onclick = () => saveMany(boxes.map(box => Number(box.value)));
  $('#other').onclick = () => {
    input.value = '';
    showHost();
    idle();
    input.focus();
  };
}

async function merge(result, request) {
  setState('working', 'working');
  draw(`<h2>two parts, joining them here.</h2><p class="meta" id="stage">getting the video and the audio</p>
    <div class="bar ink"><i id="fill"></i></div><p class="note">this happens in your browser, nothing goes back to gronka.</p>`);
  const sizes = result.files.map(file => file.size ?? 0);
  const got = result.files.map(() => 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  const show = () => {
    const sum = got.reduce((a, b) => a + b, 0);
    $('#stage').textContent = total
      ? `getting the parts, ${mb(sum)} of ${mb(total)}`
      : `getting the parts, ${mb(sum)}`;
    if (total) $('#fill').style.width = `${Math.min(88, (88 * sum) / total)}%`;
  };
  try {
    const blobs = await Promise.all(
      result.files.map((file, i) =>
        fetchWithProgress(file.url, bytes => {
          got[i] = bytes;
          show();
        })
      )
    );
    $('#stage').textContent = 'joining video and audio';
    $('#fill').style.width = '94%';
    const { remux } = await import('/mux.js');
    const video = result.files.findIndex(file => file.kind === 'video');
    const v = video < 0 ? 0 : video;
    const out = await remux(blobs[v], blobs[1 - v], result.filename);
    $('#fill').style.width = '100%';
    const name = result.filename || 'gronka.mp4';
    deliverBlob(out, out.type === 'video/webm' ? name.replace(/\.\w+$/, '.webm') : name, request);
  } catch (error) {
    console.warn('browser merge failed', error);
    draw(
      `<h2>asking gronka to join them instead.</h2><p class="meta">your browser couldn't do it, so the server will.</p>`
    );
    start({ split: false });
  }
}

function deliverBlob(blob, filename, request) {
  setState('done', 'done');
  draw(`<h2>got it.</h2><p class="meta">${esc(filename)} · ${mb(blob.size)}</p>
    <p class="say note">joined in your browser from ${esc(siteOf(request.url))}'s own files.</p>
    <div class="acts"><button type="button" class="btn" id="save">${icon('download')}save file</button>
    <button type="button" class="linkish" id="other">another one</button></div>`);
  $('#save').onclick = () => save(blob, filename);
  $('#other').onclick = () => {
    input.value = '';
    showHost();
    idle();
    input.focus();
  };
  if (navigator.userActivation?.isActive ?? true) save(blob, filename);
  else $('#save').focus();
}

async function checkHealth() {
  const up = await online();
  asleep.hidden = up;
  if (!up && root.dataset.state === 'idle') pose('asleep');
  if (up && root.dataset.state === 'idle') pose('idle');
  return up;
}

form.addEventListener('submit', event => {
  event.preventDefault();
  start();
});
input.addEventListener('input', showHost);
const intent = () => {
  warmTurnstile();
  for (const name of ['verify', 'working', 'done', 'failed', 'think', 'slow'])
    new Image().src = `/p/${name}.svg`;
};
input.addEventListener('focus', intent, { once: true });
input.addEventListener('paste', event => {
  const url = firstUrl(event.clipboardData.getData('text'));
  if (!url) return;
  event.preventDefault();
  input.value = url;
  showHost();
});

if (navigator.clipboard?.readText) {
  $('#paste').hidden = false;
  $('#paste').onclick = async () => {
    intent();
    try {
      const url = firstUrl(await navigator.clipboard.readText());
      if (!url) {
        hostLine.textContent = "there's no link on your clipboard";
        return;
      }
      input.value = url;
      showHost();
      start();
    } catch {
      input.focus();
    }
  };
}

document.addEventListener('keydown', event => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing) {
    event.preventDefault();
    input.focus();
  } else if (event.key === 'Escape' && root.dataset.state !== 'idle') {
    idle();
    input.focus();
  } else if (event.key === 'Escape' && document.activeElement === input) {
    input.value = '';
    showHost();
  }
});

if (!reduceMotion) {
  const turb = document.querySelector('#wobble feTurbulence');
  let seed = 0;
  setInterval(() => {
    if (/working|verifying/.test(root.dataset.state))
      turb.setAttribute('seed', 3 + (seed = (seed + 1) % 3));
  }, 140);
}

const params = new URLSearchParams(location.search);
const prefill =
  params.get('u') || (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '');
if (prefill && firstUrl(prefill)) {
  input.value = firstUrl(prefill);
  history.replaceState(null, '', '/');
  showHost();
  intent();
  start();
} else {
  checkHealth();
}
