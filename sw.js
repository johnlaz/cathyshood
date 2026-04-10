// ============================================================
// CATHY'S NEIGHBORHOOD — Service Worker v2.0
// Strategy: Cache-First with Network Fallback
// ============================================================

const CACHE_NAME = 'cathys-hood-v5.2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './CathysHood.png',
  './shared/cn-core.js',
  './shared/room-shell.css',
  './shared/room-shell.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './rooms/test/index.html',
  './rooms/kitchen/index.html',
  './rooms/kitchen/bg.png',
  './rooms/pond/index.html',
  './rooms/pond/bg.png',
  './rooms/construction/index.html',
  'rooms/home/index.html',
  './rooms/construction/bg.png',
  './rooms/mower/index.html',
  './rooms/mower/bg.png',
  './rooms/garden/index.html',
  './rooms/garden/bg.png',
  './rooms/music/index.html',
  './rooms/music/bg.png',
  './rooms/driveway/index.html',
  './rooms/driveway/bg.png',
  './rooms/garage/index.html',
  './rooms/garage/bg.png',
  './rooms/salon/index.html',
  './rooms/salon/bg.png',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800;900&family=Fredoka+One&display=swap',
];

// ── INSTALL: Cache all static assets ──
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: Clean old caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: Cache-First strategy ──
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
