<script>
  import { onMount } from 'svelte';
  import { currentRoute, initRouter, navigate } from './utils/router.js';
  import {
    LayoutDashboard,
    TriangleAlert,
    Server,
    Globe,
    SlidersHorizontal,
    PanelLeftClose,
    PanelLeftOpen,
    Menu,
    Sun,
    Moon,
  } from 'lucide-svelte';
  import { navStats, issueStates, startNavStats } from './stores/nav.js';
  import { isOpen } from './issues.js';
  import Overview from './pages/Overview.svelte';
  import Issues from './pages/Issues.svelte';
  import Workers from './pages/Workers.svelte';
  import Sources from './pages/Sources.svelte';
  import BotSettings from './pages/BotSettings.svelte';

  const SIDEBAR_KEY = 'gronka:sidebar-open';
  const THEME_KEY = 'gronka:theme';

  const items = [
    { page: 'dashboard', label: 'Overview', icon: LayoutDashboard },
    { page: 'issues', label: 'Issues', icon: TriangleAlert },
    { page: 'system', label: 'Workers & queue', icon: Server },
    { page: 'sources', label: 'Sources', icon: Globe },
  ];
  const settingsItem = { page: 'settings', label: 'Settings', icon: SlidersHorizontal };
  const PAGES = {
    dashboard: Overview,
    issues: Issues,
    system: Workers,
    sources: Sources,
    settings: BotSettings,
  };

  let sidebarOpen = $state(true);
  let theme = $state('light');

  const activePage = $derived(PAGES[$currentRoute.page] ? $currentRoute.page : 'dashboard');
  const activeTitle = $derived(
    [...items, settingsItem].find(i => i.page === activePage)?.label ?? activePage
  );
  const PageComponent = $derived(PAGES[activePage]);
  const issueCount = $derived(
    ($navStats?.issues ?? []).filter(g => isOpen(g, $issueStates)).length
  );

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
    const stopNav = startNavStats();
    window.addEventListener('keydown', onKeydown);
    return () => {
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

  function go(page) {
    navigate(page);
    if (window.innerWidth <= 768) sidebarOpen = false;
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
      {#each items as item (item.page)}
        {@const Icon = item.icon}
        <button
          class="link"
          class:active={activePage === item.page}
          aria-current={activePage === item.page ? 'page' : undefined}
          title={sidebarOpen ? null : item.label}
          onclick={() => go(item.page)}
        >
          <Icon size={16} strokeWidth={1.9} />
          {#if sidebarOpen}
            <span class="grow">{item.label}</span>
            {#if item.page === 'issues' && issueCount}
              <span class="count alert">{issueCount}</span>
            {:else if item.page === 'system' && $navStats?.paused}
              <span class="count alert">paused</span>
            {/if}
          {:else if (item.page === 'issues' && issueCount) || (item.page === 'system' && $navStats?.paused)}
            <span class="pip"></span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="foot">
      <button
        class="link"
        class:active={activePage === 'settings'}
        title={sidebarOpen ? null : 'Settings'}
        onclick={() => go('settings')}
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
      <div class="tools">
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
      <div class="page">
        <PageComponent />
      </div>
    {/if}
  </div>
</div>

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
  .tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .page {
    flex: 1;
    padding: 24px 32px 48px;
    width: 100%;
    max-width: 1312px;
    margin: 0 auto;
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
    .page {
      padding: 16px 16px 40px;
    }
    :global(kbd) {
      display: none !important;
    }
  }
</style>
