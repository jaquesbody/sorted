/* =============================================================================
   sw.js
   Minimal service worker — required by browsers for "installable" PWA status,
   also gives basic offline access to the app shell. Cache-first strategy.
   Bump CACHE_NAME when static assets change to force a refresh.
   ============================================================================= */

const CACHE_NAME = 'sorted-v1';

const SHELL_FILES = [
  'index.html',
  'spend.html',
  'due.html',
  'savings.html',
  'item.html',
  'manifest.json',
  'static/css/main.css',
  'static/css/sorted.css',
  'static/js/db.js',
  'static/js/utils.js',
  'static/js/categories.js',
  'static/js/dashboard.js',
  'static/js/spend.js',
  'static/js/due.js',
  'static/js/savings.js',
  'static/js/item-form.js',
  'static/js/ocr.js',
  'static/icons/icon-192.png',
  'static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never intercept Tesseract's vendor files or the language data — those
  // are large and versioned by filename already, caching them here just
  // adds complexity for no real benefit.
  if (event.request.url.includes('/static/vendor/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
