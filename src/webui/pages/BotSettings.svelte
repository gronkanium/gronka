<script>
  import { sendJson } from '../utils/api.js';
  import {
    Share2,
    HardDrive,
    ShieldCheck,
    SlidersHorizontal,
    Globe,
    Check,
    ArrowUpRight,
    SquareSlash,
  } from 'lucide-svelte';
  import { currentRoute, navigate } from '../utils/router.js';
  import PageHeader from '../components/PageHeader.svelte';
  import TierChart from '../components/TierChart.svelte';
  import { refreshNav } from '../stores/nav.js';

  // Each setting names its section on the server; unknown sections fall into "other" so none vanish.
  const SECTIONS = [
    {
      id: 'delivery',
      label: 'Delivery',
      icon: Share2,
      blurb: 'How the bot hands files back to Discord',
    },
    {
      id: 'storage',
      label: 'Limits and storage',
      icon: HardDrive,
      blurb: 'How long uploads live in R2 and how much it may hold',
    },
    {
      id: 'commands',
      label: 'Slash commands',
      icon: SquareSlash,
      blurb: 'What Discord offers when someone types /',
      commands: true,
    },
    {
      id: 'access',
      label: 'Availability',
      icon: ShieldCheck,
      blurb: 'When the bot stops taking work',
    },
  ];
  // Edited on their own pages, not here.
  const ELSEWHERE = new Set(['sources', 'issues']);
  const label = key => settings[key]?.label ?? key.replace(/_/g, ' ');

  let settings = $state({});
  let loading = $state(true);
  let error = $state('');
  let saving = $state({});
  let drafts = $state({});
  let tierDrafts = $state({});
  let toast = $state('');
  let toastTimer;

  const sections = $derived.by(() => {
    const keys = Object.keys(settings).filter(k => !ELSEWHERE.has(settings[k].section));
    const known = new Set(SECTIONS.map(s => s.id));
    const other = keys.filter(k => !known.has(settings[k].section));
    return [
      ...SECTIONS.map(s => ({ ...s, keys: keys.filter(k => settings[k].section === s.id) })),
      ...(other.length
        ? [{ id: 'other', label: 'Other', icon: SlidersHorizontal, keys: other, blurb: '' }]
        : []),
    ];
  });
  const active = $derived(
    sections.find(s => s.id === $currentRoute.params.$section) ?? sections[0]
  );
  const activeKeys = $derived(active.keys.filter(k => settings[k]));

  const parseTiers = v =>
    String(v || '')
      .split(',')
      .map(p => p.trim().split(':').map(Number))
      .filter(([mb, h]) => Number.isFinite(mb) && Number.isFinite(h))
      .map(([mb, hours]) => ({ mb, hours }));
  const cleanTiers = rows =>
    rows
      .map(r => ({ mb: Math.floor(Number(r.mb)), hours: Math.floor(Number(r.hours)) }))
      .filter(r => r.mb > 0 && r.hours > 0)
      .sort((a, b) => a.mb - b.mb);
  const serializeTiers = rows =>
    cleanTiers(rows)
      .map(r => `${r.mb}:${r.hours}`)
      .join(',');

  async function load() {
    loading = true;
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      settings = (await res.json()).settings;
      drafts = Object.fromEntries(Object.entries(settings).map(([k, s]) => [k, s.value]));
      tierDrafts = Object.fromEntries(
        Object.entries(settings)
          .filter(([, s]) => s.type === 'tiers')
          .map(([k, s]) => [k, parseTiers(s.value)])
      );
    } catch (err) {
      error = err.message || 'failed to load settings';
    } finally {
      loading = false;
    }
  }
  load();

  function say(text) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2000);
  }

  let confirming = $state(false);
  let registering = $state(false);
  let registered = $state('');
  async function register() {
    registering = true;
    error = '';
    const res = await sendJson('/api/commands/register', 'POST', { confirm: true }).catch(
      () => null
    );
    const data = res ? await res.json().catch(() => ({})) : {};
    registering = false;
    confirming = false;
    if (res?.ok) {
      registered = `Registered ${data.count} commands`;
      say(registered);
    } else error = `Commands: ${data.error || 'could not reach the webui server'}`;
  }

  async function save(key, value) {
    saving[key] = true;
    error = '';
    try {
      const res = await sendJson(`/api/settings/${key}`, 'PUT', { value });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      settings[key].value = data.value;
      drafts[key] = data.value;
      if (settings[key].type === 'tiers') tierDrafts[key] = parseTiers(data.value);
      say(`${label(key)} saved`);
      refreshNav();
    } catch (err) {
      error = `${label(key)}: ${err.message}`;
    } finally {
      saving[key] = false;
    }
  }
</script>

<PageHeader title="Settings" description="Changes apply within a minute">
  {#snippet actions()}
    {#if error}<span class="pill bad">{error}</span>{/if}
  {/snippet}
</PageHeader>

<div class="settings">
  <nav class="side" aria-label="settings sections">
    {#each sections as s (s.id)}
      {@const Icon = s.icon}
      <button
        class="sec"
        class:on={active.id === s.id}
        onclick={() => navigate('settings', { section: s.id })}
      >
        <Icon size={15} strokeWidth={1.8} /><span>{s.label}</span>
      </button>
    {/each}
    <button class="sec" onclick={() => navigate('sources')}
      ><Globe size={15} strokeWidth={1.8} /><span>Sources</span><span class="arrow"
        ><ArrowUpRight size={13} /></span
      ></button
    >
  </nav>

  <section class="panel content" aria-label={active.label}>
    <div class="ph">
      <span>{active.label}</span>
      {#if active.blurb}<span class="sub">{active.blurb}</span>{/if}
    </div>
    {#if loading}
      <div class="skel-rows">
        {#each Array(4) as _, i (i)}<span class="skeleton" style="width:{60 - i * 8}%"
          ></span>{/each}
      </div>
    {:else}
      {#each activeKeys as key (key)}
        {@const s = settings[key]}
        <div class="item" class:stacked={s.type === 'tiers'}>
          <div class="lbl">
            <b>{label(key)}</b>
            <p>{s.description}</p>
          </div>
          <div class="ctl">
            {#if s.type === 'boolean'}
              <button
                class="toggle"
                class:on={s.value === 'true'}
                role="switch"
                aria-checked={s.value === 'true'}
                aria-label={label(key)}
                disabled={saving[key]}
                onclick={() => save(key, s.value !== 'true')}
              ></button>
              <span class="small muted">{s.value === 'true' ? 'On' : 'Off'}</span>
            {:else if s.type === 'select'}
              <select
                class="field"
                value={s.value}
                disabled={saving[key]}
                onchange={e => save(key, e.currentTarget.value)}
              >
                {#each s.options as o (o)}<option value={o}>{o.replace(/_/g, ' ')}</option>{/each}
              </select>
            {:else if s.type === 'number' || s.type === 'string'}
              <form
                class="row"
                onsubmit={e => {
                  e.preventDefault();
                  save(key, drafts[key]);
                }}
              >
                <input
                  class="field"
                  class:wide={s.type === 'string'}
                  type={s.type === 'number' ? 'number' : 'text'}
                  min={s.min}
                  max={s.max}
                  bind:value={drafts[key]}
                />
                {#if s.min !== undefined}<span class="dim small nowrap">{s.min}–{s.max}</span>{/if}
                {#if String(drafts[key]) !== String(s.value)}<button
                    class="btn primary sm"
                    disabled={saving[key]}><Check size={12} />Save</button
                  >{/if}
              </form>
            {:else if s.type === 'tiers'}
              <TierChart
                bind:tiers={tierDrafts[key]}
                maxMb={Number(settings.max_video_size_mb?.value) || 1024}
              />
              {#if serializeTiers(tierDrafts[key] ?? []) !== s.value}
                <div class="row">
                  <button class="btn sm" onclick={() => (tierDrafts[key] = parseTiers(s.value))}
                    >Discard</button
                  >
                  <button
                    class="btn primary sm"
                    disabled={saving[key] || !serializeTiers(tierDrafts[key] ?? [])}
                    onclick={() => save(key, serializeTiers(tierDrafts[key]))}
                    ><Check size={12} />Save</button
                  >
                </div>
              {/if}
            {:else}
              <span class="mono dim small">{s.value}</span>
            {/if}
          </div>
        </div>
      {/each}
      {#if active.commands}
        <div class="item">
          <div class="lbl">
            <b>Register commands</b>
            <p>
              Replace the bot's commands on Discord with the ones this version defines. Use it when
              Discord shows an old or missing command.
            </p>
          </div>
          <div class="ctl">
            {#if confirming}
              <span class="small muted">Replace them on Discord?</span>
              <button class="btn sm" disabled={registering} onclick={() => (confirming = false)}
                >Cancel</button
              >
              <button class="btn primary sm" disabled={registering} onclick={register}
                >Register</button
              >
            {:else}
              <button class="btn sm" onclick={() => (confirming = true)}>Register…</button>
            {/if}
            {#if registered}<span class="small muted">{registered}</span>{/if}
          </div>
        </div>
      {/if}
    {/if}
  </section>
</div>

{#if toast}<div class="toast" role="status"><Check size={14} />{toast}</div>{/if}

<style>
  .settings {
    display: grid;
    grid-template-columns: 200px minmax(0, 720px);
    gap: var(--gap-lg);
    align-items: start;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 80px;
  }
  .sec {
    height: 34px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-soft);
    font: inherit;
    font-size: var(--fs);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .sec :global(svg) {
    color: var(--text-muted);
  }
  .sec:hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .sec.on {
    background: var(--card-3);
    color: var(--text-bright);
    font-weight: 600;
  }
  .sec.on :global(svg) {
    color: var(--text-bright);
  }
  .arrow {
    margin-left: auto;
    color: var(--text-dim);
    display: flex;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
    gap: 24px;
    padding: 16px;
    border-top: 1px solid var(--line);
    align-items: center;
  }
  .item:hover {
    background: var(--card-2);
  }
  .ph + .item {
    border-top: 0;
  }
  .lbl b {
    font-weight: 600;
    font-size: var(--fs);
    color: var(--text-bright);
  }
  .lbl p {
    margin: 3px 0 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-muted);
  }
  .ctl {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }
  .ctl .row {
    justify-content: flex-end;
  }
  .field.wide {
    width: 100%;
  }
  .field[type='number'] {
    width: 100px;
  }
  .item.stacked {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .item.stacked .ctl {
    justify-content: flex-end;
  }
  @media (max-width: 860px) {
    .settings {
      grid-template-columns: 1fr;
    }
    .side {
      position: static;
      flex-direction: row;
      overflow-x: auto;
    }
    .sec span {
      white-space: nowrap;
    }
    .item {
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .ctl,
    .ctl .row {
      justify-content: flex-start;
    }
  }
</style>
