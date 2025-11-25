// Test version of main.js - try mounting with App.test.svelte
import { mount } from 'svelte';
import App from '../App.svelte';

// Wait for DOM to be ready
function init() {
  const target = document.getElementById('app');
  if (!target) {
    console.error('Target element #app not found');
    return;
  }

  try {
    mount(App, { target });
    console.log('App mounted successfully');
  } catch (error) {
    console.error('Error mounting app:', error);
  }
}

// Script is loaded at end of body, but ensure DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
