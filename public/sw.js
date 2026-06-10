// ═══════════════════════════════════════════════════════
//  BEECOIN PRO — Service Worker
//  Gestisce cache offline e aggiornamenti PWA
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'beecoin-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: precache assets statici ────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: pulisce cache vecchie ─────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: Network-first, fallback cache ─────────────────
self.addEventListener('fetch', event => {
  // WebSocket e API non cacheati
  if (event.request.url.includes('/api/') ||
      event.request.url.startsWith('ws')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Aggiorna cache con risposta fresca
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push notifications (future use) ─────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  self.registration.showNotification(data.title || '🐝 Beecoin', {
    body: data.body || 'Nuova notifica dal mercato!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
