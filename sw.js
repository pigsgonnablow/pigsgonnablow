const CACHE_NAME = 'burger-pig-v31';
const ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './js/iso.js',
  './js/audio.js',
  './js/leaderboard.js',
  './js/auth.js',
  './js/shop.js',
  './js/myskins.js',
  './js/rules.js',
  './js/movement.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // The cache-first strategy below is only for this app's own static assets. Without this
  // origin check it also intercepted cross-origin API calls (Supabase) -- the first leaderboard
  // fetch would get cached and silently served stale forever after, no matter how fresh the
  // data on the server actually was. Let every cross-origin request (and non-GET requests)
  // go straight to the network, untouched.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // No `.catch()` here: if we get this far `cached` is already known falsy (the `||`
      // above only reaches fetch() when there was nothing to serve from the cache), so a
      // fallback to `cached` on a failed fetch could only ever produce `undefined`. Offline
      // with nothing cached is a real network error -- let it surface as one.
      return cached || fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
