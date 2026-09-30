<script>
  import { onMount } from 'svelte';
  import { currentRoute, initRouter, navigate } from './utils/router.js';
  import {
    useSse,
    reconnect,
    connected as wsConnected,
    connectionHealth,
  } from './stores/sse-store.js';
  import {
    LayoutDashboard,
    Activity,
    TriangleAlert,
    TerminalSquare,
    Server,
    HardDrive,
    Users as UsersIcon,
    Shield,
    Globe,
    SlidersHorizontal,
    PanelLeftClose,
    PanelLeftOpen,
    ChevronRight,
  } from 'lucide-svelte';
  import NavFlyout from './components/NavFlyout.svelte';
  import { navStats, savedViews, issueStates, startNavStats, removeView } from './stores/nav.js';
  import { isOpen } from './issues.js';
  import { menuFor } from './nav-menus.js';
  import { headerActions, headerCrumbs } from './stores/header.js';
  import Overview from './pages/Overview.svelte';
  import Requests from './pages/Requests.svelte';
  import RequestDetail from './pages/Request.svelte';
  import Logs from './pages/Logs.svelte';
  import Users from './pages/Users.svelte';
  import UserProfile from './pages/UserProfile.svelte';
  import Issues from './pages/Issues.svelte';
  import Workers from './pages/Workers.svelte';
  import Storage from './pages/Storage.svelte';
  import Moderation from './pages/Moderation.svelte';
  import Sources from './pages/Sources.svelte';
  import BotSettings from './pages/BotSettings.svelte';

  const SIDEBAR_STORAGE_KEY = 'gronka:sidebar-open';

  const sections = [
    { items: [{ page: 'dashboard', label: 'Overview', icon: LayoutDashboard }] },
    {
      name: 'Activity',
      items: [
        { page: 'requests', label: 'Requests', icon: Activity },
        { page: 'issues', label: 'Issues', icon: TriangleAlert },
        { page: 'logs', label: 'Logs', icon: TerminalSquare },
      ],
    },
    {
      name: 'People',
      items: [
        { page: 'users', label: 'Users', icon: UsersIcon },
        { page: 'moderation', label: 'Moderation', icon: Shield },
      ],
    },
    {
      name: 'System',
      items: [
        { page: 'system', label: 'Workers & queue', icon: Server },
        { page: 'storage', label: 'Storage', icon: HardDrive },
        { page: 'sources', label: 'Sources', icon: Globe },
      ],
    },
  ];
  const settingsItem = { page: 'settings', label: 'Settings', icon: SlidersHorizontal };
  const allItems = [...sections.flatMap(s => s.items), settingsItem];
  const PAGES = {
    dashboard: Overview,
    requests: Requests,
    request: RequestDetail,
    logs: Logs,
    issues: Issues,
    system: Workers,
    storage: Storage,
    users: Users,
    'user-profile': UserProfile,
    moderation: Moderation,
    sources: Sources,
    settings: BotSettings,
  };
  // Pages that lay out their own full-height view instead of a padded column.
  const FULL_BLEED = new Set(['logs']);
  const PARENT = { 'user-profile': 'users', request: 'requests' };

  let sidebarOpen = $state(true);
  let fly = $state(null);
  let flyout = $state();
  let openTimer;
  let closeTimer;

  const activePage = $derived($currentRoute.page);
  const navPage = $derived(PARENT[activePage] ?? activePage);
  const activeTitle = $derived(
    { 'user-profile': 'User', request: 'Request' }[activePage] ??
      allItems.find(i => i.page === activePage)?.label ??
      activePage
  );
  const PageComponent = $derived(PAGES[activePage]);
  const isOnline = $derived($connectionHealth?.isOnline !== false);
  const connStatus = $derived($wsConnected ? 'live' : isOnline ? 'connecting' : 'offline');
  const crumbs = $derived($headerCrumbs?.list ?? null);

  $effect(() => {
    document.title =
      activePage === 'dashboard' ? 'gronka' : `gronka · ${activeTitle.toLowerCase()}`;
  });

  onMount(() => {
    try {
      // On a phone the sidebar covers the page, so it always starts closed there.
      sidebarOpen =
        window.innerWidth > 768 && localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
    } catch {
      sidebarOpen = window.innerWidth > 768;
    }
    initRouter();
    const cleanup = useSse();
    const stopNav = startNavStats();
    window.addEventListener('keydown', onKeydown);
    return () => {
      cleanup?.();
      stopNav();
      window.removeEventListener('keydown', onKeydown);
    };
  });

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
    } catch {
      // storage unavailable
    }
  }

  function go(page, params) {
    navigate(page, params);
    if (window.innerWidth <= 768) sidebarOpen = false;
  }

  // Sidebar counts, from the same numbers the flyouts show.
  function badge(page) {
    if (page === 'requests') return $navStats?.requests.total;
    if (page === 'users') return $navStats?.users;
    return undefined;
  }
  const issueCount = $derived(
    ($navStats?.issues ?? []).filter(g => isOpen(g, $issueStates)).length
  );

  const canFly = () => window.matchMedia('(hover: hover) and (min-width: 769px)').matches;

  function showMenu(item, target, now = false) {
    if (!canFly() || !menuFor(item.page, $navStats, $savedViews, $issueStates)) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    const open = () => (fly = { item, top: target.getBoundingClientRect().top });
    if (now || fly) open();
    else openTimer = setTimeout(open, 90);
  }
  function hideMenu() {
    clearTimeout(openTimer);
    closeTimer = setTimeout(() => (fly = null), 180);
  }
  function keepMenu() {
    clearTimeout(closeTimer);
  }
  function closeMenu(refocus) {
    const page = fly?.item.page;
    fly = null;
    if (refocus) document.querySelector(`[data-nav="${page}"]`)?.focus();
  }
  function onNavKey(e, item) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      showMenu(item, e.currentTarget, true);
      queueMicrotask(() => flyout?.focusFirst());
    } else if (e.key === 'Escape') {
      closeMenu(false);
    }
  }
  function pick(entry) {
    const page = entry.page ?? fly.item.page;
    fly = null;
    go(page, { ...entry.params });
  }

  function onKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
  }
</script>

<a href="#main-content" class="skip-link">skip to content</a>
<div class="shell" class:collapsed={!sidebarOpen}>
  <nav class="sidebar" aria-label="primary">
    <div class="brand">
      <img class="mark" src="/favicon.svg" alt="" />
      {#if sidebarOpen}<span class="name">gronka</span>{/if}
      <button
        class="icon-btn collapse"
        onclick={toggleSidebar}
        title={sidebarOpen ? 'collapse sidebar (Ctrl+B)' : 'expand sidebar (Ctrl+B)'}
        aria-label={sidebarOpen ? 'collapse sidebar' : 'expand sidebar'}
        aria-expanded={sidebarOpen}
      >
        {#if sidebarOpen}<PanelLeftClose size={15} />{:else}<PanelLeftOpen size={15} />{/if}
      </button>
    </div>

    <div class="nav">
      {#each sections as section, i (i)}
        {#if section.name && sidebarOpen}<div class="section">{section.name}</div>{/if}
        {#if section.name && !sidebarOpen}<div class="section-rule"></div>{/if}
        {#each section.items as item (item.page)}
          {@const Icon = item.icon}
          <button
            class="link"
            data-nav={item.page}
            class:active={navPage === item.page}
            class:hover={fly?.item.page === item.page}
            aria-current={navPage === item.page ? 'page' : undefined}
            aria-haspopup={menuFor(item.page, null, []) ? 'menu' : undefined}
            aria-expanded={menuFor(item.page, null, []) ? fly?.item.page === item.page : undefined}
            title={sidebarOpen ? null : item.label}
            onclick={() => {
              fly = null;
              go(item.page);
            }}
            onmouseenter={e => showMenu(item, e.currentTarget)}
            onmouseleave={hideMenu}
            onkeydown={e => onNavKey(e, item)}
          >
            <Icon size={16} strokeWidth={1.8} />
            {#if sidebarOpen}
              <span class="grow">{item.label}</span>
              {#if item.page === 'issues' && issueCount}
                <span class="count alert">{issueCount}</span>
              {:else if item.page === 'system' && $navStats?.paused}
                <span class="count alert">paused</span>
              {:else if badge(item.page) != null}
                <span class="count">{badge(item.page).toLocaleString()}</span>
              {/if}
            {:else if item.page === 'issues' && issueCount}
              <span class="pip"></span>
            {:else if item.page === 'system' && $navStats?.paused}
              <span class="pip"></span>
            {/if}
          </button>
        {/each}
      {/each}
    </div>

    <div class="foot">
      <button
        class="link"
        data-nav="settings"
        class:active={activePage === 'settings'}
        class:hover={fly?.item.page === 'settings'}
        aria-haspopup="menu"
        aria-expanded={fly?.item.page === 'settings'}
        title={sidebarOpen ? null : 'Settings'}
        onclick={() => {
          fly = null;
          go('settings');
        }}
        onmouseenter={e => showMenu(settingsItem, e.currentTarget)}
        onmouseleave={hideMenu}
        onkeydown={e => onNavKey(e, settingsItem)}
      >
        <SlidersHorizontal size={16} strokeWidth={1.8} />
        {#if sidebarOpen}<span>Settings</span>{/if}
      </button>
      <button
        class="conn conn-{connStatus}"
        onclick={reconnect}
        title={$wsConnected
          ? `live feed connected, ${$connectionHealth?.messageCount ?? 0} messages received`
          : 'click to reconnect the live feed'}
      >
        <span class="dot"></span>
        {#if sidebarOpen}
          <span class="grow">{connStatus}</span>
          {#if $navStats?.version}<span class="ver mono">v{$navStats.version}</span>{/if}
        {/if}
      </button>
    </div>
  </nav>

  {#if sidebarOpen}<div class="scrim" onclick={toggleSidebar} role="presentation"></div>{/if}

  <div class="main" id="main-content">
    <header class="topbar">
      <button class="icon-btn mobile-only" onclick={toggleSidebar} aria-label="open menu">
        <PanelLeftOpen size={18} />
      </button>
      {#if crumbs}
        <nav class="crumbs" aria-label="breadcrumb">
          {#each crumbs as c, i (i)}
            {#if i}<ChevronRight size={13} class="sep" />{/if}
            {#if i < crumbs.length - 1}
              <button class="crumb" onclick={() => go(c.page, c.params)}>{c.label}</button>
            {:else}
              <h1 class="cur ellipsis" class:mono={c.mono}>{c.label}</h1>
            {/if}
          {/each}
        </nav>
      {:else}
        <h1>{activeTitle}</h1>
      {/if}
      <div class="actions">
        {#if $headerActions}{@render $headerActions()}{/if}
      </div>
    </header>

    {#if PageComponent}
      <div class="page" class:full={FULL_BLEED.has(activePage)}>
        <PageComponent />
      </div>
    {/if}
  </div>
</div>

{#if fly}
  <NavFlyout
    bind:this={flyout}
    title={fly.item.label}
    menu={menuFor(fly.item.page, $navStats, $savedViews, $issueStates)}
    top={fly.top}
    left={sidebarOpen ? 222 : 50}
    onpick={pick}
    onremove={name => removeView(name)}
    onenter={keepMenu}
    onleave={hideMenu}
    onclose={closeMenu}
  />
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: var(--font);
    font-size: var(--fs);
    background-color: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  :global(*) {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--surface-3) transparent;
  }
  :global(*)::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  :global(*)::-webkit-scrollbar-thumb {
    background-color: var(--surface-3);
    border-radius: 4px;
  }
  :global(code),
  :global(pre),
  :global(kbd) {
    font-family: var(--mono);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*),
    :global(*)::before,
    :global(*)::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
    }
  }

  .shell {
    display: flex;
    min-height: 100vh;
  }
  .sidebar {
    width: var(--sidebar-w);
    flex-shrink: 0;
    height: 100vh;
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-deep);
    border-right: 1px solid var(--border);
    font-size: var(--fs);
    transition: width 0.18s ease;
  }
  .collapsed .sidebar {
    width: var(--sidebar-w-collapsed);
  }
  .brand {
    height: var(--topbar-h);
    padding: 0 10px 0 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--line);
  }
  .mark {
    width: 22px;
    height: 22px;
    border-radius: 6px;
  }
  .name {
    font-weight: 600;
    font-size: var(--fs-md);
    letter-spacing: -0.01em;
    color: var(--text-bright);
  }
  .collapse {
    margin-left: auto;
  }
  .collapsed .brand {
    padding: 0;
    justify-content: center;
  }
  .collapsed .mark {
    display: none;
  }
  .collapsed .collapse {
    margin: 0;
  }
  .nav {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .section {
    padding: 16px 10px 5px;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .section-rule {
    height: 1px;
    margin: 8px 6px;
    background: var(--line);
  }
  .link {
    height: 32px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
    position: relative;
    transition:
      background 0.1s,
      color 0.1s;
  }
  .link:hover,
  .link.hover {
    background: var(--surface);
    color: var(--text-bright);
  }
  .link.active {
    background: var(--surface-2);
    color: var(--text-bright);
  }
  .link.active::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--accent-strong);
  }
  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .count.alert {
    color: var(--bg-deep);
    background: var(--warning);
    border-radius: 9px;
    padding: 1px 7px;
    font-weight: 500;
  }
  .pip {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warning);
  }
  .collapsed .link {
    justify-content: center;
    padding: 0;
  }
  .foot {
    padding: 8px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .conn {
    height: 30px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .collapsed .conn {
    justify-content: center;
  }
  .conn:hover {
    background: var(--surface);
  }
  .conn .dot {
    width: 7px;
    height: 7px;
  }
  .conn-live .dot {
    background: var(--success);
  }
  .conn-connecting .dot {
    background: var(--warning);
    animation: blink 1.2s ease-in-out infinite;
  }
  .conn-offline .dot {
    background: var(--danger);
  }
  .ver {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    height: var(--topbar-h);
    flex-shrink: 0;
    padding: 0 24px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(14, 15, 18, 0.85);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .topbar h1 {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-bright);
    min-width: 0;
  }
  .topbar .crumbs {
    gap: 4px;
    min-width: 0;
  }
  .topbar .crumbs :global(.sep) {
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .crumb {
    background: none;
    border: 0;
    padding: 2px 4px;
    margin: 0 -4px;
    border-radius: 4px;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-md);
    cursor: pointer;
  }
  .crumb:hover {
    color: var(--text-bright);
    background: var(--surface-2);
  }
  .topbar h1.mono {
    font-family: var(--mono);
    font-weight: 500;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .page {
    flex: 1;
    padding: 20px 24px 32px;
    width: 100%;
    max-width: 1480px;
    margin: 0 auto;
  }
  .page.full {
    padding: 0;
    max-width: none;
    display: flex;
    min-height: 0;
  }
  .mobile-only,
  .scrim {
    display: none;
  }
  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 2000;
    background: var(--surface-2);
    color: var(--text-bright);
    padding: 0.75rem 1rem;
    border-radius: var(--radius);
  }
  .skip-link:focus {
    left: 0.5rem;
    top: 0.5rem;
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      z-index: 1000;
      left: 0;
    }
    .collapsed .sidebar {
      width: 0;
      overflow: hidden;
      border: 0;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 999;
    }
    .mobile-only {
      display: flex;
      margin: 0;
    }
    .topbar,
    .page {
      padding-left: 16px;
      padding-right: 16px;
    }
    .page.full {
      padding: 0;
    }
    .actions {
      gap: 6px;
    }
    :global(kbd) {
      display: none !important;
    }
  }
</style>
