<script>
  import { onMount, onDestroy } from 'svelte';
  import { currentRoute, initRouter, navigate } from './utils/router.js';
  import { useWebSocket, ensureConnected, connected as wsConnected } from './stores/websocket-store.js';
  import { BarChart3, Users as UsersIcon, Settings, FileText, TrendingUp, Bell, ChevronLeft, ChevronRight, Shield } from 'lucide-svelte';
  import Stats from './pages/Stats.svelte';
  import Health from './pages/Health.svelte';
  import Operations from './pages/Operations.svelte';
  import OperationsDebug from './pages/OperationsDebug.svelte';
  import Logs from './pages/Logs.svelte';
  import Users from './pages/Users.svelte';
  import UserProfile from './pages/UserProfile.svelte';
  import Monitoring from './pages/Monitoring.svelte';
  import Alerts from './pages/Alerts.svelte';
  import Moderation from './pages/Moderation.svelte';
  import './styles/responsive.css';

  let sidebarOpen = true;
  let wsCleanup = null;
  let connectionCheckInterval = null;

  onMount(() => {
    initRouter();
    // Initialize websocket connection at app level to persist across page navigations
    wsCleanup = useWebSocket();
    
    // Periodically check connection and reconnect if needed
    connectionCheckInterval = setInterval(() => {
      ensureConnected();
    }, 5000); // Check every 5 seconds
  });

  onDestroy(() => {
    // Cleanup websocket when app is destroyed
    if (connectionCheckInterval) {
      clearInterval(connectionCheckInterval);
    }
    if (wsCleanup) {
      wsCleanup();
    }
  });

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  function navigateTo(page) {
    navigate(page);
  }

  $: activePage = $currentRoute.page;
</script>

<main class:sidebar-open={sidebarOpen}>
  <nav class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-header">
      <h1>gronka</h1>
      <button class="toggle-btn" on:click={toggleSidebar}>
        {#if sidebarOpen}
          <ChevronLeft size={16} />
        {:else}
          <ChevronRight size={16} />
        {/if}
      </button>
    </div>
    <ul class="nav-menu">
      <li class:active={activePage === 'dashboard'}>
        <button on:click={() => navigateTo('dashboard')}>
          <span class="icon"><BarChart3 size={20} /></span>
          {#if sidebarOpen}<span class="label">dashboard</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'users'}>
        <button on:click={() => navigateTo('users')}>
          <span class="icon"><UsersIcon size={20} /></span>
          {#if sidebarOpen}<span class="label">users</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'operations'}>
        <button on:click={() => navigateTo('operations')}>
          <span class="icon"><Settings size={20} /></span>
          {#if sidebarOpen}<span class="label">operations</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'logs'}>
        <button on:click={() => navigateTo('logs')}>
          <span class="icon"><FileText size={20} /></span>
          {#if sidebarOpen}<span class="label">logs</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'monitoring'}>
        <button on:click={() => navigateTo('monitoring')}>
          <span class="icon"><TrendingUp size={20} /></span>
          {#if sidebarOpen}<span class="label">monitoring</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'alerts'}>
        <button on:click={() => navigateTo('alerts')}>
          <span class="icon"><Bell size={20} /></span>
          {#if sidebarOpen}<span class="label">alerts</span>{/if}
        </button>
      </li>
      <li class:active={activePage === 'moderation'}>
        <button on:click={() => navigateTo('moderation')}>
          <span class="icon"><Shield size={20} /></span>
          {#if sidebarOpen}<span class="label">moderation</span>{/if}
        </button>
      </li>
    </ul>
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

  <div class="main-content">
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
    {:else if activePage === 'operations'}
      <div class="page-header">
        <h2>operations</h2>
      </div>
      <div class="page-content">
        <Operations />
      </div>
    {:else if activePage === 'operations-debug'}
      <div class="page-content">
        <OperationsDebug />
      </div>
    {:else if activePage === 'logs'}
      <div class="page-header">
        <h2>logs</h2>
      </div>
      <div class="page-content">
        <Logs />
      </div>
    {:else if activePage === 'monitoring'}
      <div class="page-header">
        <h2>monitoring</h2>
      </div>
      <div class="page-content">
        <Monitoring />
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
    {/if}
  </div>
</main>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background-color: #1a1a1a;
    color: #e0e0e0;
    line-height: 1.6;
    /* Hide scrollbars */
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  :global(html)::-webkit-scrollbar,
  :global(body)::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  :global(*) {
    box-sizing: border-box;
  }
  
  /* Hide scrollbars for all scrollable elements */
  :global(*) {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }
  
  :global(*)::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  main {
    min-height: 100vh;
    display: flex;
  }

  .sidebar {
    background-color: #0d0d0d;
    border-right: 1px solid #333;
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
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sidebar-header h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
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
    color: #aaa;
    font-size: 1rem;
    cursor: pointer;
    padding: 0.25rem;
    transition: color 0.2s;
  }

  .toggle-btn:hover {
    color: #fff;
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
    color: #aaa;
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
    background-color: #1a1a1a;
    color: #fff;
  }

  .nav-menu li.active button {
    background-color: #2a2a2a;
    color: #fff;
    border-left: 3px solid #51cf66;
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

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .page-header {
    padding: 2rem;
    border-bottom: 1px solid #333;
  }

  .page-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    color: #fff;
  }

  .page-content {
    flex: 1;
    padding: 2rem;
    overflow-y: auto;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    padding: 2rem;
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
    }

    .page-content {
      padding: 1rem;
    }

    .dashboard-grid {
      padding: 1rem;
      gap: 1rem;
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
      background-color: #0d0d0d;
      border: 1px solid #333;
      border-radius: 4px;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1001;
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    
    .mobile-sidebar-toggle:hover {
      background-color: #1a1a1a;
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

