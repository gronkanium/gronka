<script>
  /**
   * Side panel for one log line: message, fields grouped into request context and the rest, per
   * field "Filter by" / "Exclude" / "Copy value", and every line written for the same request.
   *
   *   line      the selected log line
   *   related   lines sharing its op id, oldest first
   *   onfilter  (key, value, exclude) => void
   *   onselect  (line) => void          pick another line (from "Same request")
   *   onstep    (dir) => void           previous (-1) / next (+1) line in the list
   *   onclose   () => void
   */
  import {
    X,
    Copy,
    Check,
    ZoomIn,
    ZoomOut,
    ChevronUp,
    ChevronDown,
    Link2,
    Crosshair,
    ArrowUpRight,
  } from 'lucide-svelte';
  import { navigate } from '../utils/router.js';
  import { formatRelativeTime } from '../utils/format.js';
  import LogLevel, { FIELDS, compColor, clock, fullStamp, lv, utc } from './LogLevel.svelte';

  let {
    line,
    related = [],
    onfilter,
    onselect,
    onstep,
    onclose,
    canPrev = false,
    canNext = false,
  } = $props();

  const CONTEXT = ['component', 'source', 'command', 'worker', 'op', 'user', 'job'];
  let copied = $state('');

  const text = v => (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  const context = $derived(
    CONTEXT.map(k => [k, k === 'component' ? line.component : line.metadata?.[k]]).filter(
      ([, v]) => v != null && v !== ''
    )
  );
  const other = $derived([
    ...Object.entries(
      line.metadata && typeof line.metadata === 'object' ? line.metadata : {}
    ).filter(([k, v]) => !CONTEXT.includes(k) && v != null && v !== ''),
    ['id', line.id],
    ['timestamp', line.timestamp],
  ]);
  const first = $derived(related[0]?.timestamp ?? line.timestamp);
  const offset = t => {
    const d = (t - first) / 1000;
    return d < 10 ? `+${d.toFixed(2)}s` : `+${d.toFixed(1)}s`;
  };

  function copy(value, key) {
    navigator.clipboard?.writeText(value);
    copied = key;
    setTimeout(() => copied === key && (copied = ''), 1200);
  }
</script>

<aside class="detail" aria-label="selected line">
  <header class="dh">
    <LogLevel level={line.level} />
    <span class="when" title="{utc(line.timestamp)} · {formatRelativeTime(line.timestamp)}"
      >{fullStamp(line.timestamp)}</span
    >
    <span class="rel">{formatRelativeTime(line.timestamp)}</span>
    <span class="nav">
      <button
        class="icon-btn sm"
        onclick={() => onstep?.(-1)}
        disabled={!canPrev}
        title="newer line (k)"
        aria-label="newer line"><ChevronUp size={15} /></button
      >
      <button
        class="icon-btn sm"
        onclick={() => onstep?.(1)}
        disabled={!canNext}
        title="older line (j)"
        aria-label="older line"><ChevronDown size={15} /></button
      >
      <button class="icon-btn sm" onclick={onclose} title="close (esc)" aria-label="close"
        ><X size={15} /></button
      >
    </span>
  </header>

  <div class="scroll">
    <div class="msg">
      <pre>{line.message}</pre>
      <button
        class="icon-btn sm copy"
        onclick={() => copy(line.message, 'message')}
        title="copy message"
        aria-label="copy message"
        >{#if copied === 'message'}<Check size={14} />{:else}<Copy size={14} />{/if}</button
      >
    </div>

    {#each [['Context', context], ['Other', other]] as [title, rows] (title)}
      {#if rows.length}
        <div class="sh">{title}</div>
        <dl class="fields">
          {#each rows as [k, v] (k)}
            {@const filterable = FIELDS.includes(k)}
            <div class="f">
              <dt>{k}</dt>
              <dd title={text(v)}>
                {#if k === 'component'}<i class="cdot" style="background:{compColor(v)}"></i>{/if}
                <span class="val">{text(v)}</span>
              </dd>
              <span class="acts">
                {#if filterable}
                  <button
                    class="icon-btn sm"
                    onclick={() => onfilter?.(k, text(v), false)}
                    title="Filter by {k}:{text(v)}"
                    aria-label="filter by {k}"><ZoomIn size={13} /></button
                  >
                  <button
                    class="icon-btn sm"
                    onclick={() => onfilter?.(k, text(v), true)}
                    title="Exclude {k}:{text(v)}"
                    aria-label="exclude {k}"><ZoomOut size={13} /></button
                  >
                {/if}
                <button
                  class="icon-btn sm"
                  onclick={() => copy(text(v), k)}
                  title="Copy value"
                  aria-label="copy {k}"
                  >{#if copied === k}<Check size={13} />{:else}<Copy size={13} />{/if}</button
                >
              </span>
            </div>
          {/each}
        </dl>
      {/if}
    {/each}

    {#if related.length}
      <div class="sh">Same request <span class="n tnum">{related.length}</span></div>
      <div class="related">
        {#each related as r (r.id)}
          <button
            class="rr"
            class:cur={r.id === line.id}
            onclick={() => onselect?.(r)}
            title="{clock(r.timestamp)} · {r.component}"
          >
            <span class="off tnum">{offset(r.timestamp)}</span>
            <i class="ldot" style="background:{lv(r.level).color}"></i>
            <span class="m">{r.message}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <footer class="actions">
    {#if line.metadata?.op}
      <button class="btn sm" onclick={() => navigate('logs', { op: line.metadata.op })}
        ><Link2 size={12} />Only this request</button
      >
    {/if}
    <button
      class="btn sm"
      onclick={() =>
        navigate('logs', {
          startTime: String(line.timestamp - 30000),
          endTime: String(line.timestamp + 30000),
        })}><Crosshair size={12} />±30 s around</button
    >
    <button class="btn sm" onclick={() => copy(JSON.stringify(line, null, 2), 'json')}
      >{#if copied === 'json'}<Check size={12} />Copied{:else}<Copy size={12} />Copy{/if}</button
    >
    {#if line.metadata?.op}
      <button
        class="btn sm ghost right"
        onclick={() => navigate('request', { requestId: line.metadata.op })}
        title="open the request this line belongs to">Request<ArrowUpRight size={12} /></button
      >
    {/if}
  </footer>
</aside>

<style>
  .detail {
    width: 480px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--card);
  }
  .dh {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .when {
    font: var(--fs-sm) var(--mono);
    color: var(--text-bright);
    white-space: nowrap;
  }
  .rel {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .nav {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 12px;
  }
  .msg {
    position: relative;
    margin: 14px 16px 4px;
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .msg pre {
    margin: 0;
    padding: 12px 40px 12px 14px;
    font: var(--fs-sm) / 18px var(--mono);
    color: var(--text-bright);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg .copy {
    position: absolute;
    top: 6px;
    right: 6px;
  }
  .sh {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 16px 16px 6px;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
  }
  .sh .n {
    font: 500 var(--fs-xs) var(--mono);
    color: var(--text-muted);
  }
  .fields {
    margin: 0;
    padding: 0 8px;
  }
  .f {
    position: relative;
    height: 28px;
    display: grid;
    grid-template-columns: 38% minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
  }
  .f:hover {
    background: var(--card-2);
  }
  dt {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  dd {
    margin: 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font: var(--fs-sm) var(--mono);
    color: var(--text-bright);
  }
  .val {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cdot,
  .ldot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .acts {
    position: absolute;
    right: 4px;
    top: 1px;
    display: flex;
    gap: 1px;
    padding-left: 12px;
    background: linear-gradient(to right, transparent, var(--card-2) 12px);
    border-radius: var(--radius-sm);
    opacity: 0;
    pointer-events: none;
  }
  .f:hover .acts,
  .acts:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  .related {
    padding: 0 8px;
  }
  .rr {
    width: 100%;
    height: 26px;
    display: grid;
    grid-template-columns: 58px 7px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: var(--fs-sm) var(--mono);
    text-align: left;
    cursor: pointer;
  }
  .rr:hover {
    background: var(--row-hover);
  }
  .rr.cur {
    background: var(--row-selected);
    color: var(--text-bright);
  }
  .off {
    color: var(--text-muted);
    text-align: right;
  }
  .rr .m {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
    background: var(--card);
  }
  .actions .right {
    margin-left: auto;
  }
</style>
