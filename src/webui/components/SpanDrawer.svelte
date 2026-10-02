<script>
  import { Check, Copy, Link, X, ArrowUpRight } from 'lucide-svelte';
  import { formatDateTime, formatTime } from '../utils/format.js';
  import { createCopier } from '../utils/copier.svelte.js';
  import { fmtDur, plus, pctOf, levelOf, spanAttrs } from '../trace.js';
  import CopyValue from './CopyValue.svelte';

  let { selected, span, logsHref, onselect } = $props();
  const copier = createCopier();

  const selAttrs = $derived(spanAttrs(selected));
  const selMessage = $derived(
    selected.type === 'span' ? String(selected.raw?.message || selected.label || '') : ''
  );
  const slowest = $derived(
    selected.type === 'group'
      ? selected.kids.reduce((a, b) => (b.took > a.took ? b : a), selected.kids[0])
      : null
  );
</script>

<section class="panel drawer" aria-label="Span detail">
  <div class="ph dph">
    <span class="sw t-{selected.tone}"></span>
    {#if selected.type === 'group'}
      <span class="grow ellipsis" title={selected.label}>{selected.label}</span>
    {:else}
      <span class="chip lvl {selected.tone}">{levelOf(selected)}</span>
      <span class="grow ellipsis mono dcomp" title={selected.component}
        >{selected.component ?? 'span'}</span
      >
    {/if}
    <button
      class="icon-btn sm"
      title={copier.copied === 'span-link' ? 'Copied' : 'Copy link to this span'}
      aria-label="Copy link to this span"
      onclick={() => copier.copy(location.href, 'span-link')}
      >{#if copier.copied === 'span-link'}<Check size={14} />{:else}<Link size={14} />{/if}</button
    >
    <button
      class="icon-btn sm"
      title="Close (Esc)"
      aria-label="Close span detail"
      onclick={() => onselect(null)}><X size={15} /></button
    >
  </div>

  <div class="dsec">
    <div class="section-label">Overview</div>
    <dl class="ov">
      {#if selected.type === 'span'}
        <dt>Component</dt>
        <dd class="mono ellipsis">{selected.component ?? '—'}</dd>
      {/if}
      <dt>Worker</dt>
      <dd class="mono ellipsis">
        {selected.worker ?? (selected.bot ? 'bot (gateway)' : '—')}
      </dd>
      <dt>Started at</dt>
      <dd class="mono" title={formatDateTime(selected.at, { seconds: true })}>
        {formatTime(selected.at, { millis: true })}
      </dd>
      <dt>Offset</dt>
      <dd class="mono">{plus(selected.offset)}</dd>
      <dt>Duration</dt>
      <dd class="mono">{fmtDur(selected.took)}</dd>
      <dt>% of trace</dt>
      <dd class="pct">
        <span class="mono">{pctOf(selected.took, span)}</span>
        <span class="pbar"
          ><span
            class="t-{selected.tone}"
            style="width:{Math.min(100, (selected.took / span) * 100)}%"
          ></span></span
        >
      </dd>
      {#if selected.type === 'group'}
        <dt>Spans</dt>
        <dd class="mono">{selected.kids.length}</dd>
        <dt>Errors</dt>
        <dd class="mono" class:error-text={selected.errors}>{selected.errors}</dd>
      {/if}
    </dl>
  </div>

  {#if selected.type === 'span'}
    <div class="dsec">
      <div class="dsec-h">
        <span class="section-label">Message</span>
        <button class="btn ghost sm" onclick={() => copier.copy(selMessage, 'msg')}
          >{#if copier.copied === 'msg'}<Check size={13} />Copied{:else}<Copy
              size={13}
            />Copy{/if}</button
        >
      </div>
      <pre class="msgblock" class:err={selected.tone === 'err'}>{selMessage}</pre>
    </div>

    {#if selAttrs.length}
      <div class="dsec flush">
        <div class="section-label pad">Attributes</div>
        <dl class="kv">
          {#each selAttrs as [k, v] (k)}
            <div class="kvr">
              <dt class="ellipsis" title={k}>{k}</dt>
              <dd><CopyValue text={v} label={k} /></dd>
            </div>
          {/each}
        </dl>
      </div>
    {/if}
  {:else if slowest}
    <div class="dsec">
      <div class="section-label">Slowest span</div>
      <button class="slowest" onclick={() => onselect(slowest.key)}>
        <span class="sw t-{slowest.tone}"></span>
        <span class="grow ellipsis" title={slowest.label}>{slowest.label}</span>
        <span class="mono dim">{fmtDur(slowest.took)}</span>
      </button>
    </div>
  {/if}

  <div class="pf dfoot">
    <span class="mono dim">span {selected.key}</span>
    <a class="right view-logs" href={logsHref}>View in logs<ArrowUpRight size={13} /></a>
  </div>
</section>

<style>
  .t-bot {
    --c: var(--text-muted);
  }
  .t-worker {
    --c: var(--chart-1);
  }
  .t-err {
    --c: var(--danger);
  }
  .t-warn {
    --c: var(--warning);
  }
  .sw {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
    background: var(--c);
  }
  .drawer {
    max-height: calc(100vh - 88px);
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .dph {
    gap: 8px;
    padding-right: 10px;
    position: sticky;
    top: 0;
    background: var(--card);
    z-index: 1;
  }
  .dph .sw {
    width: 10px;
    height: 10px;
  }
  .dcomp {
    font-size: var(--fs);
    font-weight: 500;
  }
  .lvl {
    font-family: var(--mono);
    letter-spacing: 0.04em;
  }
  .lvl.err {
    color: var(--danger-text);
    border-color: var(--danger-border);
    background: var(--danger-bg);
  }
  .lvl.warn {
    color: var(--warning-text);
    border-color: var(--warning-border);
    background: var(--warning-bg);
  }
  .lvl.worker {
    color: var(--accent);
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .dsec {
    padding: 14px 20px;
    border-bottom: 1px solid var(--line);
  }
  .dsec.flush {
    padding: 14px 0 8px;
  }
  .section-label.pad {
    padding: 0 20px;
  }
  .dsec-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: -4px 0 6px;
  }
  .dsec > .section-label {
    margin-bottom: 8px;
  }
  .ov {
    margin: 0;
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    row-gap: 8px;
    column-gap: 12px;
    font-size: var(--fs);
  }
  .ov dt {
    color: var(--text-muted);
  }
  .ov dd {
    margin: 0;
    min-width: 0;
    color: var(--text-bright);
  }
  .ov dd.mono {
    font-size: var(--fs-sm);
  }
  .pct {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pct .mono {
    font-size: var(--fs-sm);
    min-width: 44px;
  }
  .pbar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--card-3);
    overflow: hidden;
  }
  .pbar span {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--c);
  }
  .msgblock {
    margin: 0;
    padding: 10px 12px;
    max-height: 220px;
    overflow: auto;
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: var(--fs-sm) / 18px var(--mono);
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msgblock.err {
    color: var(--danger-text);
    background: var(--danger-bg-subtle);
    border-color: var(--danger-border);
  }
  .kv {
    margin: 8px 0 0;
  }
  .kvr {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    min-height: 28px;
    padding: 0 12px 0 20px;
  }
  .kvr:nth-child(odd) {
    background: var(--card-2);
  }
  .kvr dt {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .kvr dd {
    margin: 0;
    min-width: 0;
    color: var(--text);
  }
  .slowest {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    font-size: var(--fs);
    text-align: left;
  }
  .slowest:hover {
    background: var(--row-hover);
  }
  .slowest .mono {
    font-size: var(--fs-sm);
  }
  .dfoot {
    margin-top: auto;
    border-top: 0;
  }
  .dfoot .mono {
    font-size: var(--fs-xs);
  }
  .view-logs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 500;
  }
</style>
