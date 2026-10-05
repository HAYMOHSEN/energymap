// EnergyMap service worker — makes the app work fully offline.
const VERSION = 'energymap-1.0.0';
const ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/state.js',
  './js/actions.js',
  './js/scheduler.js',
  './js/time.js',
  './js/quickadd.js',
  './js/ics.js',
  './js/ui.js',
  './js/undo.js',
  './js/views/plan.js',
  './js/views/tasks.js',
  './js/views/energy.js',
  './js/views/insights.js',
  './js/views/settings.js',
  './js/views/dialogs.js',
  './icons/icon-32.png',
  './icons/icon-96.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  // bypass the HTTP cache so an update never stores stale files
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('energymap-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    return undefined;
  })());
});
