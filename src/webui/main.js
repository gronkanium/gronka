import { mount } from 'svelte';
import App from './App.svelte';

// Wait for DOM to be ready
function init() {
  const target = document.getElementById('app');
  if (!target) {
    console.error('Target element #app not found');
    return;
  }

  mount(App, { target });
}

// Script is loaded at end of body, but ensure DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
