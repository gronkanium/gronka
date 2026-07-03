<script>
  import { onMount, onDestroy } from 'svelte';
  import { currentRoute, initRouter, navigate } from './utils/router.js';
  import {
    useWebSocket,
    reconnect,
    connected as wsConnected,
    connectionHealth,
  } from './stores/websocket-store.js';
  import { BarChart3, Users as UsersIcon, FileText, Bell, ChevronLeft, ChevronRight, Shield, List, SlidersHorizontal } from 'lucide-svelte';
  import Stats from './pages/Stats.svelte';
  import Health from './pages/Health.svelte';
  import Requests from './pages/Requests.svelte';
  import Logs from './pages/Logs.svelte';
  import Users from './pages/Users.svelte';
  import UserProfile from './pages/UserProfile.svelte';
  import Alerts from './pages/Alerts.svelte';
  import Moderation from './pages/Moderation.svelte';
  import BotSettings from './pages/BotSettings.svelte';
  import './styles/responsive.css';

  const SIDEBAR_STORAGE_KEY = 'gronka:sidebar-open';

  // Restore the sidebar's collapsed/open state from a previous visit. Defaults to
  // open, and stays open if storage is unavailable (private mode, etc.).
  function loadSidebarState() {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  }

  // Nav items drive both the sidebar and the per-page document title / heading,
  // so the labels only live in one place.
  const navItems = [
    { page: 'dashboard', label: 'dashboard', icon: BarChart3 },
    { page: 'users', label: 'users', icon: UsersIcon },
    { page: 'requests', label: 'requests', icon: List },
    { page: 'logs', label: 'logs', icon: FileText },
    { page: 'alerts', label: 'alerts', icon: Bell },
    { page: 'moderation', label: 'moderation', icon: Shield },
    { page: 'settings', label: 'settings', icon: SlidersHorizontal },
  ];

  // Pages reachable by deep link that aren't top-level nav entries.
  const pageTitles = {
    'user-profile': 'user profile',
  };

  let sidebarOpen = true;
  let wsCleanup = null;

  onMount(() => {
    sidebarOpen = loadSidebarState();
    initRouter();
    // Initialize websocket connection at app level to persist across page navigations
    // (the store self-heals: onclose reconnect with backoff + stale-connection check)
    wsCleanup = useWebSocket();

    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    // Cleanup websocket when app is destroyed
    if (wsCleanup) {
      wsCleanup();
    }
    window.removeEventListener('keydown', handleKeydown);
  });

  function persistSidebarState() {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
    } catch {
      // Storage unavailable — state simply won't persist across reloads.
    }
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    persistSidebarState();
  }

  function navigateTo(page) {
    navigate(page);
    // On mobile the sidebar overlays the content, so collapse it after a jump.
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      sidebarOpen = false;
    }
  }

  function handleKeydown(event) {
    // Ignore shortcuts while typing in a field.
    const target = event.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    // Escape collapses the sidebar when it's overlaying content on mobile.
    if (
      event.key === 'Escape' &&
      !typing &&
      sidebarOpen &&
      typeof window !== 'undefined' &&
      window.innerWidth <= 768
    ) {
      sidebarOpen = false;
    }
  }

  $: activePage = $currentRoute.page;
  $: activeTitle =
    pageTitles[activePage] || navItems.find(item => item.page === activePage)?.label || activePage;

  // Keep the browser tab title in sync with the current page.
  $: if (typeof document !== 'undefined') {
    document.title = activePage === 'dashboard' ? 'gronka dashboard' : `gronka · ${activeTitle}`;
  }

  // Connection status for the sidebar footer indicator.
  $: isOnline = $connectionHealth?.isOnline !== false;
  $: connStatus = $wsConnected ? 'live' : isOnline ? 'connecting' : 'offline';
  $: connLabel = $wsConnected ? 'live' : isOnline ? 'connecting…' : 'offline';
  $: connTitle = $wsConnected
    ? `real-time connection active — ${$connectionHealth?.messageCount ?? 0} messages received`
    : isOnline
      ? 'reconnecting to the live feed — click to retry now'
      : 'device is offline';
</script>

<a href="#main-content" class="skip-link">skip to content</a>
<main class:sidebar-open={sidebarOpen}>
  <nav class="sidebar" class:open={sidebarOpen} aria-label="primary">
    <div class="sidebar-header">
      <h1>gronka</h1>
      <button
        class="toggle-btn"
        on:click={toggleSidebar}
        title={sidebarOpen ? 'collapse sidebar (Ctrl+B)' : 'expand sidebar (Ctrl+B)'}
        aria-label={sidebarOpen ? 'collapse sidebar' : 'expand sidebar'}
        aria-expanded={sidebarOpen}
      >
        {#if sidebarOpen}
          <ChevronLeft size={16} />
        {:else}
          <ChevronRight size={16} />
        {/if}
      </button>
    </div>
    <ul class="nav-menu">
      {#each navItems as item (item.page)}
        {@const Icon = item.icon}
        <li class:active={activePage === item.page}>
          <button
            on:click={() => navigateTo(item.page)}
            title={sidebarOpen ? null : item.label}
            aria-current={activePage === item.page ? 'page' : undefined}
          >
            <span class="icon"><Icon size={20} /></span>
            {#if sidebarOpen}<span class="label">{item.label}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    <div class="sidebar-footer">
      <button
        class="conn-status conn-{connStatus}"
        on:click={reconnect}
        title={connTitle}
        aria-label={`connection status: ${connLabel}. click to reconnect`}
      >
        <span class="conn-dot"></span>
        {#if sidebarOpen}<span class="conn-label">{connLabel}</span>{/if}
      </button>
    </div>
  </nav>

  <!-- Mobile sidebar toggle button -->
  <button 
    class="mobile-sidebar-toggle" 
    class:hidden={sidebarOpen}
    on:click={toggleSidebar}
    aria-label="Toggle sidebar"
  >
    <ChevronRight size={20} />
  </button>

  <div class="main-content" id="main-content">
    {#if activePage === 'dashboard'}
      <div class="page-header">
        <h2>dashboard</h2>
      </div>
      <div class="dashboard-grid">
        <Stats />
        <Health />
      </div>
    {:else if activePage === 'users'}
      <div class="page-header">
        <h2>users</h2>
      </div>
      <div class="page-content">
        <Users />
      </div>
    {:else if activePage === 'user-profile'}
      <div class="page-header">
        <h2>user profile</h2>
      </div>
      <div class="page-content">
        <UserProfile />
      </div>
    {:else if activePage === 'requests'}
      <div class="page-header">
        <h2>requests</h2>
      </div>
      <div class="page-content">
        <Requests />
      </div>
    {:else if activePage === 'logs'}
      <div class="page-header">
        <h2>logs</h2>
      </div>
      <div class="page-content">
        <Logs />
      </div>
    {:else if activePage === 'alerts'}
      <div class="page-header">
        <h2>alerts</h2>
      </div>
      <div class="page-content">
        <Alerts />
      </div>
    {:else if activePage === 'moderation'}
      <div class="page-header">
        <h2>moderation</h2>
      </div>
      <div class="page-content">
        <Moderation />
      </div>
    {:else if activePage === 'settings'}
      <div class="page-header">
        <h2>settings</h2>
      </div>
      <div class="page-content">
        <BotSettings />
      </div>
    {/if}
  </div>
</main>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background-color: var(--bg);
    color: var(--text);
    line-height: 1.6;
  }

  :global(*) {
    box-sizing: border-box;
  }

  /* Slim, themed scrollbars: subtle enough to keep the clean look, but present
     so long log/table views still signal that there's more to scroll. */
  :global(*) {
    scrollbar-width: thin; /* Firefox */
    scrollbar-color: var(--surface-3) transparent; /* Firefox: thumb, track */
  }

  :global(*)::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  :global(*)::-webkit-scrollbar-track {
    background: transparent;
  }

  :global(*)::-webkit-scrollbar-thumb {
    background-color: var(--surface-3);
    border-radius: 4px;
  }

  :global(*)::-webkit-scrollbar-thumb:hover {
    background-color: var(--border-2);
  }

  main {
    min-height: 100vh;
    display: flex;
  }

  /* Respect users who ask for less motion: drop transitions and the status
     pulse rather than animating the shell. */
  @media (prefers-reduced-motion: reduce) {
    :global(*),
    :global(*)::before,
    :global(*)::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
    }
  }

  .sidebar {
    background-color: var(--bg-deep);
    border-right: 1px solid var(--border);
    transition: width 0.3s ease;
    width: 60px;
    min-height: 100vh;
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
  }

  .sidebar.open {
    width: 220px;
  }

  .sidebar-header {
    padding: 1.5rem 1rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sidebar-header h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text-bright);
    white-space: nowrap;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .sidebar.open .sidebar-header h1 {
    opacity: 1;
  }

  .toggle-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1rem;
    cursor: pointer;
    padding: 0.25rem;
    transition: color 0.2s;
  }

  .toggle-btn:hover {
    color: var(--text-bright);
  }

  .nav-menu {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
  }

  .nav-menu li {
    margin: 0;
  }

  .nav-menu button {
    width: 100%;
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 1rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    cursor: pointer;
    transition: background-color 0.2s, color 0.2s;
    text-align: left;
    font-size: 0.95rem;
  }

  .nav-menu button:hover {
    background-color: var(--bg);
    color: var(--text-bright);
  }

  .nav-menu li.active button {
    background-color: var(--surface-2);
    color: var(--text-bright);
    border-left: 3px solid var(--success);
  }

  .nav-menu .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    color: inherit;
  }

  .nav-menu .label {
    white-space: nowrap;
  }

  .sidebar-footer {
    border-top: 1px solid var(--border);
    padding: 0.5rem;
  }

  .conn-status {
    width: 100%;
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    font-size: 0.85rem;
    border-radius: var(--radius);
    transition: background-color 0.2s, color 0.2s;
  }

  .sidebar:not(.open) .conn-status {
    justify-content: center;
  }

  .conn-status:hover {
    background-color: var(--bg);
    color: var(--text-bright);
  }

  .conn-dot {
    width: 8px;
    height: 8px;
    min-width: 8px;
    border-radius: 50%;
    background-color: var(--text-dim);
  }

  .conn-live .conn-dot {
    background-color: var(--success);
    box-shadow: 0 0 0 0 var(--success);
    animation: conn-pulse 2s infinite;
  }

  .conn-connecting .conn-dot {
    background-color: var(--warning);
    animation: conn-blink 1.2s ease-in-out infinite;
  }

  .conn-offline .conn-dot {
    background-color: var(--danger);
  }

  .conn-label {
    white-space: nowrap;
  }

  @keyframes conn-pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(81, 207, 102, 0.5);
    }
    70% {
      box-shadow: 0 0 0 5px rgba(81, 207, 102, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(81, 207, 102, 0);
    }
  }

  @keyframes conn-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 2000;
    background-color: var(--surface-2);
    color: var(--text-bright);
    padding: 0.75rem 1rem;
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    text-decoration: none;
  }

  .skip-link:focus {
    left: 0.5rem;
    top: 0.5rem;
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .page-header {
    padding: 2rem;
    border-bottom: 1px solid var(--border);
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
  }

  .page-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    color: var(--text-bright);
  }

  .page-content {
    flex: 1;
    padding: 2rem;
    overflow-y: auto;
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
  }

  @media (max-width: 1024px) {
    .dashboard-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      z-index: 1000;
      height: 100vh;
      left: 0;
      top: 0;
    }

    .sidebar:not(.open) {
      width: 0;
      overflow: hidden;
      border-right: none;
    }

    .main-content {
      width: 100%;
      margin-left: 0;
    }

    .page-header {
      padding: 1rem;
      max-width: 100%;
    }

    .page-content {
      padding: 1rem;
      max-width: 100%;
    }

    .dashboard-grid {
      padding: 1rem;
      gap: 1rem;
      max-width: 100%;
    }
    
    /* Add overlay when sidebar is open on mobile */
    .sidebar.open::after {
      content: '';
      position: fixed;
      top: 0;
      left: 220px;
      right: 0;
      bottom: 0;
      background-color: rgba(0, 0, 0, 0.5);
      z-index: -1;
    }
    
    /* Mobile sidebar toggle button */
    .mobile-sidebar-toggle {
      position: fixed;
      top: 1rem;
      left: 1rem;
      width: 44px;
      height: 44px;
      background-color: var(--bg-deep);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text-bright);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1001;
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    
    .mobile-sidebar-toggle:hover {
      background-color: var(--bg);
      transform: scale(1.05);
    }
    
    .mobile-sidebar-toggle.hidden {
      display: none;
    }
  }
  
  /* Hide mobile toggle on desktop */
  @media (min-width: 769px) {
    .mobile-sidebar-toggle {
      display: none;
    }
  }
</style>

