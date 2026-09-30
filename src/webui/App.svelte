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
    Menu,
    Sun,
    Moon,
    Search,
  } from 'lucide-svelte';
  import NavFlyout from './components/NavFlyout.svelte';
  import { navStats, savedViews, issueStates, startNavStats, removeView } from './stores/nav.js';
  import { isOpen } from './issues.js';
  import { menuFor } from './nav-menus.js';
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

  const SIDEBAR_KEY = 'gronka:sidebar-open';
  const THEME_KEY = 'gronka:theme';

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
  const PARENT = { 'user-profile': 'users', request: 'requests' };
  // Pages where every pixel is data get the full width.
  const WIDE = new Set(['logs', 'requests']);

  let sidebarOpen = $state(true);
  let theme = $state('light');
  let fly = $state(null);
  let flyout = $state();
  let jump = $state('');
  let jumpInput = $state();
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

  $effect(() => {
    document.title =
      activePage === 'dashboard' ? 'gronka' : `gronka · ${activeTitle.toLowerCase()}`;
  });
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  onMount(() => {
    try {
      // On a phone the sidebar covers the page, so it always starts closed there.
      sidebarOpen = window.innerWidth > 768 && localStorage.getItem(SIDEBAR_KEY) !== 'false';
      const saved = localStorage.getItem(THEME_KEY);
      theme =
        saved === 'dark' || saved === 'light'
          ? saved
          : matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
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
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // storage unavailable
    }
  }
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage unavailable
    }
  }

  function go(page, params) {
    navigate(page, params);
    if (window.innerWidth <= 768) sidebarOpen = false;
  }

  // The jump box understands the ids that appear everywhere in the product.
  function onJump(e) {
    if (e.key === 'Escape') {
      jump = '';
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    const raw = jump.trim();
    if (!raw) return;
    if (/^\d{15,20}$/.test(raw)) go('user-profile', { userId: raw });
    else if (/^\d{13}-[0-9a-f]{6,}$/i.test(raw)) go('request', { requestId: raw });
    else if (/^https?:\/\//i.test(raw)) go('requests', { urlPattern: raw.split('?')[0] });
    else go('requests', { urlPattern: raw });
    jump = '';
    e.currentTarget.blur();
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
    else openTimer = setTimeout(open, 120);
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
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      jumpInput?.focus();
    }
  }
</script>

<a href="#main-content" class="skip-link">skip to content</a>
<div class="shell" class:collapsed={!sidebarOpen}>
  <nav class="sidebar" aria-label="primary">
    <div class="brand">
      <img class="mark" src="/favicon.svg" alt="" />
      {#if sidebarOpen}
        <span class="name">gronka</span>
        {#if $navStats?.version}<span class="ver mono">v{$navStats.version}</span>{/if}
      {/if}
      <button
        class="icon-btn collapse"
        onclick={toggleSidebar}
        title={sidebarOpen ? 'collapse sidebar (Ctrl+B)' : 'expand sidebar (Ctrl+B)'}
        aria-label={sidebarOpen ? 'collapse sidebar' : 'expand sidebar'}
        aria-expanded={sidebarOpen}
      >
        {#if sidebarOpen}<PanelLeftClose size={16} />{:else}<PanelLeftOpen size={16} />{/if}
      </button>
    </div>

    <div class="nav">
      {#each sections as section, i (i)}
        {#if section.name}
          {#if sidebarOpen}<div class="section">{section.name}</div>{:else}<div
              class="section-rule"
            ></div>{/if}
        {/if}
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
            <Icon size={16} strokeWidth={1.9} />
            {#if sidebarOpen}
              <span class="grow">{item.label}</span>
              {#if item.page === 'issues' && issueCount}
                <span class="count alert">{issueCount}</span>
              {:else if item.page === 'system' && $navStats?.paused}
                <span class="count alert">paused</span>
              {:else if badge(item.page) != null}
                <span class="count">{badge(item.page).toLocaleString()}</span>
              {/if}
            {:else if (item.page === 'issues' && issueCount) || (item.page === 'system' && $navStats?.paused)}
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
        <SlidersHorizontal size={16} strokeWidth={1.9} />
        {#if sidebarOpen}<span class="grow">Settings</span>{/if}
      </button>
    </div>
  </nav>

  {#if sidebarOpen}<div class="scrim" onclick={toggleSidebar} role="presentation"></div>{/if}

  <div class="main" id="main-content">
    <header class="topbar">
      <button class="icon-btn mobile-only" onclick={toggleSidebar} aria-label="open menu"
        ><Menu size={20} /></button
      >
      <label class="searchbox jump">
        <Search size={15} />
        <input
          bind:this={jumpInput}
          bind:value={jump}
          onkeydown={onJump}
          placeholder="Jump to a request id, user id or link"
          aria-label="jump to"
          spellcheck="false"
        />
        <kbd>Ctrl K</kbd>
      </label>
      <div class="tools">
        <button
          class="pill conn conn-{connStatus}"
          class:ok={connStatus === 'live'}
          class:warn={connStatus === 'connecting'}
          class:bad={connStatus === 'offline'}
          onclick={reconnect}
          title={$wsConnected
            ? `live feed connected, ${$connectionHealth?.messageCount ?? 0} messages received`
            : 'click to reconnect the live feed'}
        >
          {connStatus === 'live' ? 'Live' : connStatus === 'connecting' ? 'Connecting' : 'Offline'}
        </button>
        <button
          class="icon-btn"
          onclick={toggleTheme}
          title={theme === 'dark' ? 'switch to light' : 'switch to dark'}
          aria-label="toggle theme"
        >
          {#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
        </button>
      </div>
    </header>
    {#if PageComponent}
      <div class="page" class:wide={WIDE.has(activePage)}>
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
    left={sidebarOpen ? 234 : 58}
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
    background-color: var(--canvas);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    font-feature-settings: 'cv11', 'ss01';
  }
  :global(*) {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--border-2) transparent;
  }
  :global(*)::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  :global(*)::-webkit-scrollbar-thumb {
    background-color: var(--border-2);
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
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    font-size: var(--fs);
    transition: width 0.18s ease;
  }
  .collapsed .sidebar {
    width: var(--sidebar-w-collapsed);
  }
  .brand {
    height: 56px;
    padding: 0 10px 0 18px;
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .mark {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    flex-shrink: 0;
  }
  .name {
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.02em;
    color: var(--text-bright);
  }
  .ver {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    margin-top: 2px;
  }
  .collapse {
    margin-left: auto;
    color: var(--text-dim);
  }
  .collapsed .brand {
    flex-direction: column;
    height: auto;
    padding: 12px 0 4px;
    gap: 6px;
  }
  .collapsed .collapse {
    margin: 0;
  }
  .nav {
    flex: 1;
    overflow-y: auto;
    padding: 4px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .section {
    padding: 18px 10px 6px;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .section-rule {
    height: 1px;
    margin: 10px 8px;
    background: var(--line);
  }
  .link {
    height: 34px;
    padding: 0 12px;
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
    position: relative;
    transition:
      background 0.1s,
      color 0.1s;
  }
  .link :global(svg) {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .link:hover,
  .link.hover {
    background: var(--card-3);
    color: var(--text-bright);
  }
  .link.active {
    background: var(--card-3);
    color: var(--text-bright);
    font-weight: 600;
  }
  .link.active :global(svg) {
    color: var(--text-bright);
  }
  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .count.alert {
    font-family: var(--font);
    font-weight: 600;
    color: var(--warning-text);
    background: var(--warning-bg);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .pip {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warning);
    border: 2px solid var(--sidebar);
  }
  .collapsed .link {
    justify-content: center;
    padding: 0;
  }
  .foot {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--line);
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    height: 56px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 32px;
    border-bottom: 1px solid var(--border);
    background: var(--canvas);
    position: sticky;
    top: 0;
    z-index: 50;
  }
  .jump {
    width: 380px;
    max-width: 100%;
    box-shadow: none;
    background: var(--card);
    border-color: var(--border);
  }
  .jump:hover {
    border-color: var(--border-2);
  }
  .jump:focus-within {
    background: var(--card);
  }
  .tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .conn {
    border: 0;
    cursor: pointer;
  }
  .page {
    flex: 1;
    padding: 24px 32px 48px;
    width: 100%;
    max-width: 1312px;
    margin: 0 auto;
  }
  .page.wide {
    max-width: none;
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
    background: var(--card);
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
      box-shadow: var(--shadow-pop);
    }
    .collapsed .sidebar {
      width: 0;
      overflow: hidden;
      border: 0;
      box-shadow: none;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(16, 24, 40, 0.45);
      z-index: 999;
    }
    .mobile-only {
      display: inline-flex;
    }
    .topbar {
      padding: 0 12px;
      height: 52px;
    }
    .jump {
      flex: 1;
      width: auto;
      min-width: 0;
    }
    .jump input {
      min-width: 0;
    }
    .tools .conn {
      display: none;
    }
    .page {
      padding: 16px 16px 40px;
    }
    :global(kbd) {
      display: none !important;
    }
  }
</style>
