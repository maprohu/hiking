'use strict';

// App-shell cache so the planner opens offline.
//
// Strategy:
//   • Own files (HTML/CSS/JS): NETWORK-FIRST. Always fetch the latest when
//     online; fall back to cache only when offline. This is what keeps you
//     from getting stuck on an old version — a normal refresh always wins.
//   • Leaflet CDN (versioned, immutable URLs): cache-first to save bandwidth.
//   • OSM tiles and Overpass: never touched here (route data lives in IndexedDB).
//
// Bump CACHE whenever this file changes so old caches are purged on activate.
const CACHE = 'hrp-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/geo.js',
  './js/db.js',
  './js/overpass.js',
  './js/graph.js',
  './js/router.js',
  './js/gpx.js',
  './js/app.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  // Activate the new worker immediately instead of waiting for all tabs to close.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./index.html');
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(request, copy));
  }
  return res;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/interpreter')) return;   // Overpass: always live
  if (url.hostname.endsWith('openstreetmap.org')) return;  // tiles: no SW caching

  if (url.hostname === 'unpkg.com') {
    e.respondWith(cacheFirst(e.request));                  // versioned CDN: immutable
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(e.request));                // own files: always freshest
  }
  // anything else: let the browser handle it normally
});
