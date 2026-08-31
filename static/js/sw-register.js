/* =============================================================================
   sw-register.js
   Registers the service worker — required for "Add to Home Screen" install
   and for the notification permission flow to make sense (both depend on
   this running first).
   ============================================================================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
