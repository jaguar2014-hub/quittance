// service worker Quittances de Loyer — cache v2 (PWA installable)
const CACHE_NAME = 'quittances-v2';
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/quittances-app.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => {/* pré-cache best-effort */})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Stratégie : network-first avec fallback cache pour GET.
// POST/... : on laisse passer (les envois mail échouent gracieusement si offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // pas d'offline POST
  event.respondWith(
    fetch(req)
      .then((resp) => {
        // Mise en cache opportuniste des GET réussis (même origine)
        const url = new URL(req.url);
        if (url.origin === location.origin && resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
  );
});
