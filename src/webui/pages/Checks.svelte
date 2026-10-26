<script>
  import { onMount } from 'svelte';
  import { Play, RefreshCw, ShieldCheck } from 'lucide-svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import DataTable from '../components/DataTable.svelte';
  import { sendJson } from '../utils/api.js';
  import { formatRelativeTime } from '../utils/format.js';
  import { poll } from '../utils/poll.js';
  import { refreshNav } from '../stores/nav.js';

  const STATUS = {
    fail: ['bad', 'Failing'],
    gone: ['warn', 'Post gone'],
    never: ['idle', 'Not run'],
    pass: ['ok', 'Passing'],
  };
  const ORDER = ['fail', 'gone', 'never', 'pass'];
  const TABS = [
    ['problems', 'Problems'],
    ['all', 'All'],
    ['pass', 'Passing'],
  ];

  let checks = $state([]);
  let labels = $state({});
  let enabled = $state(false);
  let running = $state(false);
  let loaded = $state(false);
  let loadError = $state('');
  let tab = $state(null);
  let busy = $state(new Set());
  let error = $state('');

  async function load() {
    try {
      const [res, sources] = await Promise.all([
        fetch('/api/sources/checks'),
        fetch('/api/sources').catch(() => null),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ checks, enabled, running } = await res.json());
      if (sources?.ok) {
        labels = Object.fromEntries((await sources.json()).sites.map(s => [s.id, s.label]));
      }
      loadError = '';
    } catch (err) {
      loadError = err.message || 'failed to load checks';
    } finally {
      loaded = true;
    }
  }
  onMount(() => {
    load();
    return poll(load, 10_000);
  });

  const statusOf = c => c.result?.status ?? 'never';
  const counts = $derived(
    Object.fromEntries(ORDER.map(s => [s, checks.filter(c => statusOf(c) === s).length]))
  );
  const problems = $derived(counts.fail + counts.gone);
  const activeTab = $derived(tab ?? (problems ? 'problems' : 'all'));
  const lists = $derived({
    problems: checks.filter(c => ['fail', 'gone'].includes(statusOf(c))),
    all: checks,
    pass: checks.filter(c => statusOf(c) === 'pass'),
  });
  const rows = $derived(
    [...lists[activeTab]].sort(
      (a, b) =>
        ORDER.indexOf(statusOf(a)) - ORDER.indexOf(statusOf(b)) ||
        (labels[a.site] ?? a.site).localeCompare(labels[b.site] ?? b.site)
    )
  );
  const lastRun = $derived(Math.max(0, ...checks.map(c => c.result?.checked_at ?? 0)));

  const columns = [
    { key: 'status', label: 'Status', width: '96px' },
    { key: 'site', label: 'Site', width: '128px', sm: false },
    { key: 'link', label: 'Example' },
    { key: 'passed', label: 'Last passed', width: '96px', align: 'right', sm: false },
    { key: 'run', label: '', width: '64px' },
  ];

  const shortLink = url => {
    try {
      const u = new URL(url);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`;
    } catch {
      return url;
    }
  };

  async function setEnabled(on) {
    error = '';
    const res = await sendJson('/api/settings/source_checks', 'PUT', { value: on }).catch(
      () => null
    );
    if (res?.ok) enabled = on;
    else error = 'could not save the setting';
  }

  async function runAll() {
    error = '';
    const res = await sendJson('/api/sources/checks/run', 'POST', {}).catch(() => null);
    if (res?.ok || res?.status === 409) running = true;
    else error = 'could not start a run';
  }

  async function runOne(check) {
    busy = new Set(busy).add(check.url);
    try {
      const res = await sendJson('/api/sources/checks/run', 'POST', { url: check.url });
      if (!res.ok) throw new Error();
      await load();
      refreshNav();
    } catch {
      error = `could not check ${shortLink(check.url)}`;
    } finally {
      const next = new Set(busy);
      next.delete(check.url);
      busy = next;
    }
  }
</script>

<PageHeader
  title="Checks"
  description="Real links downloaded once a day, so a broken source shows up here before someone hits it"
>
  {#snippet actions()}
    {#if error}<span class="error-text small">{error}</span>{/if}
    <span
      class="pill"
      class:bad={counts.fail}
      class:warn={!counts.fail && counts.gone}
      class:ok={loaded && checks.length && counts.pass === checks.length}
      class:idle={!problems && counts.pass < checks.length}
      >{running
        ? 'Running…'
        : problems
          ? `${problems} need${problems === 1 ? 's' : ''} attention`
          : counts.pass === checks.length
            ? 'All passing'
            : `${counts.never} not run yet`}</span
    >
    <label class="nightly">
      <button
        class="toggle"
        class:on={enabled}
        role="switch"
        aria-checked={enabled}
        aria-label="nightly check"
        onclick={() => setEnabled(!enabled)}
      ></button>
      Nightly
    </label>
    <button class="btn primary" disabled={running} onclick={runAll}
      ><RefreshCw size={13} /> {running ? 'Running' : 'Run all now'}</button
    >
  {/snippet}
  {#snippet below()}
    <div class="tabs" role="tablist">
      {#each TABS as [id, label] (id)}
        <button
          role="tab"
          aria-selected={activeTab === id}
          class:on={activeTab === id}
          onclick={() => (tab = id)}
        >
          {label}<span class="n">{lists[id].length}</span>
        </button>
      {/each}
    </div>
  {/snippet}
</PageHeader>

<div class="checks stack">
  {#if loaded && !enabled}
    <div class="flash warn">
      The nightly run is off, so these only run when you press Run. Turn on Nightly to check every
      example once a day.
    </div>
  {/if}
  <p class="summary dim small">
    {[
      lastRun && `Last checked ${formatRelativeTime(lastRun)}`,
      `${counts.pass} of ${checks.length} passing`,
      counts.fail && `${counts.fail} failing`,
      counts.gone && `${counts.gone} gone`,
      counts.never && `${counts.never} not run`,
    ]
      .filter(Boolean)
      .join(' · ')}
  </p>

  <DataTable
    {columns}
    {rows}
    rowKey="url"
    loading={!loaded}
    error={loadError}
    onretry={load}
    label="source checks"
  >
    {#snippet emptyState()}
      <div class="empty">
        <span class="ic"><ShieldCheck size={20} /></span>
        {#if activeTab === 'problems'}
          <b>Nothing failing</b>Every example returned what it should last time it ran
        {:else}
          <b>No results here</b>Run all now to check every example
        {/if}
      </div>
    {/snippet}
    {#snippet row(c)}
      {@const status = statusOf(c)}
      <span><span class="pill sm {STATUS[status][0]}">{STATUS[status][1]}</span></span>
      <span class="site hide-sm ellipsis">{labels[c.site] ?? c.site}</span>
      <span class="what">
        <a class="link ellipsis mono" href={c.url} target="_blank" rel="noreferrer"
          >{shortLink(c.url)}</a
        >
        <span class="l2 ellipsis" title={c.result?.cause ?? ''}>
          {#if status === 'fail' && c.result.got}
            wanted <b>{c.result.expected}</b>, got <b class="bad">{c.result.got}</b>
          {:else if status === 'fail'}
            wanted <b>{c.result.expected}</b>, got an error: {c.result.cause}
          {:else if status === 'gone'}
            the post is deleted or private, replace this example
          {:else if status === 'pass'}
            {c.result.got} in {(c.result.ms / 1000).toFixed(1)}s
          {:else}
            wants {c.expect.count > 1 ? `${c.expect.count} ${c.expect.type}` : c.expect.type}
          {/if}
        </span>
      </span>
      <span class="num dim small hide-sm"
        >{c.result?.passed_at ? formatRelativeTime(c.result.passed_at) : 'never'}</span
      >
      <span class="num">
        <button
          class="btn sm ghost"
          disabled={busy.has(c.url) || running}
          aria-label="check {shortLink(c.url)} now"
          onclick={() => runOne(c)}
          >{#if busy.has(c.url)}…{:else}<Play size={11} />{/if}</button
        >
      </span>
    {/snippet}
  </DataTable>
</div>

<style>
  .checks {
    max-width: 1100px;
  }
  .summary {
    margin: 0;
  }
  .nightly {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-sm);
    color: var(--text-soft);
  }
  .site {
    color: var(--text-bright);
    font-weight: 600;
  }
  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .what .link {
    color: var(--text-bright);
    font-size: var(--fs-sm);
    text-decoration: none;
  }
  .what .link:hover {
    text-decoration: underline;
  }
  .l2 {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .l2 b {
    color: var(--text-soft);
  }
  .l2 b.bad {
    color: var(--danger-text);
  }
  .num {
    text-align: right;
  }
</style>
