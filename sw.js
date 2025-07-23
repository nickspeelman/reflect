self.addEventListener('install', (event) => {
  console.log('[Service Worker] Install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activate');
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Let the browser handle all fetch requests — no caching yet
});
