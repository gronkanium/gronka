import {
  esc,
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
const asleep = $('#asleep');
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
// audio: he covers his eyes. no sound: he covers his ears. played as a short flipbook.
const MODE_FRAMES = {
  auto: [],
  audio: ['eyes-1', 'eyes-2', 'eyes'],
  mute: ['ears-1', 'ears-2', 'ears'],
};
let modeShown = 'auto';
let flip;
const restPose = () => MODE_FRAMES[form.mode.value]?.at(-1) ?? 'idle';
function playMode(next) {
  clearInterval(flip);
  stopFlip();
  const from = MODE_FRAMES[modeShown] ?? [];
  const to = MODE_FRAMES[next] ?? [];
  modeShown = next;
  if (root.dataset.phase !== 'idle') return;
  const back = from.length ? [...from.slice(0, -1).reverse(), 'idle'] : [];
  const frames = reduceMotion ? [to.at(-1) ?? 'idle'] : [...back, ...to];
  if (!frames.length) return;
  flip = setInterval(() => {
    pose(frames.shift());
    if (!frames.length) clearInterval(flip);
  }, 80);
}
// flipbooks, drawn by gronka-promos/projects/mascot/web.py: frames, ms per frame, loops
const range = (name, n) => Array.from({ length: n }, (_, i) => `${name}-${i + 1}`);
const FLIPS = {
  // the filing cabinet: pulls a folder, checks it, puts it back, opens the next drawer
  fetching: [range('filing', 45), Array(45).fill(133), true],
  wave: [range('wave', 12), Array(12).fill(133), false],
  still: [['still-1', 'still-2', 'still-3', 'still-2'], [1400, 900, 160, 900], true],
  gotit: [['got-1', 'got-2', 'got-3', 'done'], [140, 140, 360], false],
  party: [range('party', 40), Array(40).fill(1000 / 30), true],
  nope: [['nope-1', 'nope-2', 'failed'], [160, 420], false],
  asleep: [['asleep', 'asleep-2', 'asleep-3', 'asleep-2'], [900, 700, 900, 700], true],
  fidget: [['fidget-1', 'fidget-2', 'fidget-1', 'idle'], [500, 160, 400], false],
  gum: [
    [...range('gum', 5), 'gum-pop', 'gum-after', 'idle'],
    [420, 380, 340, 300, 260, 220, 900],
    false,
  ],
  coffee: [
    ['coffee-1', 'coffee-2', 'coffee-1', 'coffee-2', 'coffee-3', 'coffee-4', 'coffee-2', 'idle'],
    [420, 420, 420, 420, 900, 700, 420],
    false,
  ],
  paper: [
    ['paper-1', 'paper-2', 'paper-1', 'paper-3', 'paper-4', 'paper-2', 'idle'],
    [900, 900, 900, 160, 200, 900],
    false,
  ],
  yoyo: [
    [...Array(3).fill(['yoyo-1', 'yoyo-2', 'yoyo-3', 'yoyo-2']).flat(), 'idle'],
    Array(12).fill(140),
    false,
  ],
  phones: [[...Array(4).fill(range('phones', 4)).flat(), 'idle'], Array(16).fill(240), false],
  juggle: [[...Array(4).fill(range('juggle', 6)).flat(), 'idle'], Array(24).fill(120), false],
};
const ACTIVITIES = ['fidget', 'fidget', 'gum', 'coffee', 'paper', 'yoyo', 'phones', 'juggle'];
let flipTimer;
const stopFlip = () => clearTimeout(flipTimer);
const preload = names => names.forEach(name => (new Image().src = `/p/${name}.svg`));
// play a flipbook; a loop runs `times` rounds (forever by default), then `then` (a pose name or a function)
function play(name, { times = Infinity, then } = {}) {
  stopFlip();
  const [frames, ms, loop] = FLIPS[name];
  const finish = () => (typeof then === 'function' ? then() : then && pose(then));
  if (reduceMotion) {
    pose(typeof then === 'string' ? then : loop ? frames[0] : frames.at(-1));
    if (typeof then === 'function') then();
    return;
  }
  preload(frames);
  let i = 0;
  let round = 0;
  const step = () => {
    pose(frames[i]);
    const wait = ms[i] ?? 0;
    i += 1;
    if (i === frames.length) {
      round += 1;
      if (!loop || round >= times) {
        if (then) flipTimer = setTimeout(finish, wait);
        return;
      }
      i = 0;
    }
    flipTimer = setTimeout(step, wait);
  };
  step();
}
// now and then, while nobody is using the page, he does something
function scheduleActivity() {
  if (reduceMotion) return;
  setTimeout(
    () => {
      scheduleActivity();
      const idleNow =
        root.dataset.phase === 'idle' &&
        form.mode.value === 'auto' &&
        asleep.hidden &&
        !document.hidden &&
        document.activeElement !== input;
      if (idleNow) play(ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)]);
    },
    35000 + Math.random() * 35000
  );
}
function setState(state, penguin) {
  stopFlip();
  root.dataset.phase = state;
  pose(penguin);
}
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
  setState('idle', restPose());
  draw('');
}

const STAGES = [
  [0, 'looking at the link'],
  [3, 'getting it from {site}'],
  [12, 'still getting it, this one is big'],
  [45, 'a big file. still going'],
];

function working(site) {
  setState('working', 'filing-1');
  play('fetching');
  let longWait = false;
  draw(`<h2><span class="spin" aria-hidden="true"></span>on it.</h2><p class="meta" id="stage"></p>
    <div class="acts"><button type="button" class="linkish" id="cancel">cancel</button></div>`);
  $('#cancel').onclick = idle;
  const began = Date.now();
  const tick = () => {
    const t = (Date.now() - began) / 1000;
    const text = STAGES.filter(([at]) => t >= at)
      .pop()[1]
      .replace('{site}', site);
    $('#stage').textContent = `${text}. ${Math.floor(t)} s`;
    if (t >= 45 && !longWait) {
      longWait = true;
      play('still');
    }
  };
  tick();
  timer = setInterval(tick, 500);
}

const COPY = {
  BAD_URL: ['that link looks off.', 'think'],
  BAD_REQUEST: ["that didn't work. try a different link.", 'think'],
  VALIDATION_ERROR: ["can't do that one.", 'failed'],
  CONTENT_GONE: ["it's gone.", 'failed'],
  DOWNLOAD_FAILED: ["couldn't get it.", 'failed'],
  NETWORK_ERROR: ["the site didn't answer.", 'shrug'],
  VERIFICATION_FAILED: ["cloudflare couldn't check this browser.", 'think'],
  VERIFY_BLOCKED: ["the check didn't load.", 'think'],
  VERIFY_SLOW: ['the check is stuck.', 'think'],
  RATE_LIMITED: ['slow down a little.', 'slow'],
  OFFLINE: ['gronka is asleep.', 'asleep'],
  MERGE_FAILED: ["couldn't join the video and audio.", 'failed'],
  INTERNAL: ['something broke on our side.', 'failed'],
};

function showError(error) {
  stopTimer();
  job = null;
  if (error.code === 'RATE_LIMITED') return countdown(error);
  const [title, penguin] = COPY[error.code] ?? COPY.INTERNAL;
  setState('error', penguin);
  if (penguin === 'failed') play('nope');
  const again = [
    'OFFLINE',
    'NETWORK_ERROR',
    'VERIFICATION_FAILED',
    'VERIFY_SLOW',
    'INTERNAL',
    'DOWNLOAD_FAILED',
  ].includes(error.code);
  const message = error instanceof ApiError ? error.message : 'something broke here. try again.';
  draw(`<h2>${esc(title)}</h2><p class="say">${esc(message)}</p>
    <div class="acts">${again ? `<button type="button" class="btn" id="again">try again</button>` : ''}
    <button type="button" class="btn line" id="other">another link</button></div>`);
  $('#again')?.addEventListener('click', () => start());
  $('#other').onclick = () => {
    input.value = '';
    idle();
    input.focus();
  };
  panel.querySelector('button')?.focus();
}

function countdown(error) {
  const [title] = COPY[error.code];
  let left = Math.min(Math.max(error.retryAfter ?? 60, 1), 3600);
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
      idle();
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
  // a plain fetch, not <link rel=prefetch>: cloudflare answers a prefetch it hasn't cached with a 503
  for (const file of ['libav-6.8.7.1-remux-cli.wasm.mjs', 'libav-6.8.7.1-remux-cli.wasm.wasm'])
    fetch(`/_libav/${file}`, { priority: 'low' }).catch(() => {});
  prefetchLibav.done = true;
}

async function start({ split } = {}) {
  const request = body(split);
  if (!request.url) {
    return showError(new ApiError('BAD_URL', 'paste a whole link, starting with https.', 400));
  }
  input.value = request.url;
  job?.abort();
  const controller = (job = new AbortController());
  setState('verifying', 'verify');
  draw(
    `<h2><span class="spin" aria-hidden="true"></span>one sec.</h2><p class="meta">cloudflare is checking you're a person.</p>`
  );
  if (request.mode === 'auto' && !prefetchLibav.done) prefetchLibav();
  try {
    request.turnstile = await turnstileToken('download');
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
  direct: site => `straight from ${site}. gronka never touched it.`,
  worker: () => 'passed through. gronka kept nothing.',
  r2: () => 'this link works for an hour. then the file goes.',
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
  setState('done', 'got-1');
  play('gotit', { then: () => play('party', { times: 2, then: 'done' }) });
  draw(`<h2>got it.</h2><p class="meta">${esc(name)}${file.size ? ` · ${mb(file.size)}` : ''}</p>
    <p class="say note">${LANE_NOTE[result.lane](site)}</p><p class="meta" id="saving"></p>
    <div class="acts"><button type="button" class="btn" id="save">${icon('download')}save file</button>
    <button type="button" class="btn line small" id="copy">${icon('copy')}copy link</button>
    ${navigator.share ? `<button type="button" class="btn line small" id="share">${icon('share')}share</button>` : ''}
    <button type="button" class="linkish" id="other">another link</button></div>`);
  const saving = $('#saving');
  const run = () =>
    saveOne(file, result.lane, 0, (got, total) => {
      saving.textContent = total ? `saving ${mb(got)} of ${mb(total)}` : `saving ${mb(got)}`;
    }).then(saved => {
      if (saved) {
        saving.textContent = 'saved. check your downloads.';
        return;
      }
      saving.textContent = 'this site blocks direct saving. open the file and save it there.';
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
    pose(failed.length ? 'think' : 'done');
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
    idle();
    input.focus();
  };
}

async function merge(result, request) {
  setState('working', 'filing-1');
  play('fetching');
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
  setState('done', 'got-1');
  play('gotit', { then: () => play('party', { times: 2, then: 'done' }) });
  draw(`<h2>got it.</h2><p class="meta">${esc(filename)} · ${mb(blob.size)}</p>
    <p class="say note">joined in your browser from ${esc(siteOf(request.url))}'s own files.</p>
    <div class="acts"><button type="button" class="btn" id="save">${icon('download')}save file</button>
    <button type="button" class="linkish" id="other">another one</button></div>`);
  $('#save').onclick = () => save(blob, filename);
  $('#other').onclick = () => {
    input.value = '';
    idle();
    input.focus();
  };
  if (navigator.userActivation?.isActive ?? true) save(blob, filename);
  else $('#save').focus();
}

async function checkHealth() {
  const up = await online();
  asleep.hidden = up;
  if (!up && root.dataset.phase === 'idle') play('asleep');
  if (up && root.dataset.phase === 'idle') {
    stopFlip();
    pose(restPose());
  }
  return up;
}

form.addEventListener('submit', event => {
  event.preventDefault();
  start();
});
$('.mode').addEventListener(
  'pointerover',
  () =>
    [...MODE_FRAMES.audio, ...MODE_FRAMES.mute].forEach(
      name => (new Image().src = `/p/${name}.svg`)
    ),
  { once: true }
);
form.addEventListener('change', event => {
  if (event.target.name === 'mode') playMode(event.target.value);
});
const intent = () => {
  warmTurnstile();
  for (const name of [
    'verify',
    ...FLIPS.fetching[0],
    ...FLIPS.gotit[0],
    'nope-1',
    'nope-2',
    'shrug',
    'done',
    'failed',
    'think',
    'slow',
    ...MODE_FRAMES.audio,
    ...MODE_FRAMES.mute,
  ])
    new Image().src = `/p/${name}.svg`;
};
input.addEventListener('focus', intent, { once: true });
input.addEventListener('paste', event => {
  const url = firstUrl(event.clipboardData.getData('text'));
  if (!url) return;
  event.preventDefault();
  input.value = url;
});

if (navigator.clipboard?.readText) {
  $('#paste').hidden = false;
  $('#paste').onclick = async () => {
    intent();
    try {
      const url = firstUrl(await navigator.clipboard.readText());
      if (!url) {
        stopFlip();
        pose('clipboard');
        setTimeout(() => root.dataset.phase === 'idle' && pose(restPose()), 2500);
        return;
      }
      input.value = url;
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
  } else if (event.key === 'Escape' && root.dataset.phase !== 'idle') {
    idle();
    input.focus();
  } else if (event.key === 'Escape' && document.activeElement === input) {
    input.value = '';
  }
});

if (!reduceMotion) {
  const turb = document.querySelector('#wobble feTurbulence');
  let seed = 0;
  setInterval(() => {
    if (/working|verifying/.test(root.dataset.phase))
      turb.setAttribute('seed', 3 + (seed = (seed + 1) % 3));
  }, 140);
}

const params = new URLSearchParams(location.search);
const prefill =
  params.get('u') || (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '');
if (prefill && firstUrl(prefill)) {
  input.value = firstUrl(prefill);
  history.replaceState(null, '', location.pathname);
  intent();
  start();
} else {
  // a wave hello when the page opens, unless he's asleep or someone is already at the link box
  checkHealth().then(up => {
    if (up && root.dataset.phase === 'idle' && document.activeElement !== input)
      play('wave', { then: restPose() });
  });
}
scheduleActivity();
// an activity stops the moment someone goes for the link box
input.addEventListener('focus', () => {
  if (root.dataset.phase === 'idle' && asleep.hidden) {
    stopFlip();
    pose(restPose());
  }
});
