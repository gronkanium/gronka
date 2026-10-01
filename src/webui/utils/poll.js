// Runs fn every ms while the tab is visible, and once on coming back; returns the stop function.
export function poll(fn, ms) {
  const timer = setInterval(() => document.hidden || fn(), ms);
  const onVisible = () => document.hidden || fn();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
