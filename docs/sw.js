// Offline after first load. index.html is a single static page, but "works
// offline" needs something that survives a cold start with no network, and the
// HTTP cache alone does not guarantee that. This is the smallest thing that
// does: cache the page and the three.js modules on first fetch, serve from
// cache afterwards, and fall back to the network when a request is not cached.
//
// jsDelivr sends CORS headers, so those responses are cacheable and readable
// rather than opaque.
const CACHE = 'kiln-v1';

self.addEventListener('activate', (e) => {
  // Drop older caches so a bumped CACHE name actually ships new code.
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Only cache what actually succeeded; a cached 404 is worse than none.
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
