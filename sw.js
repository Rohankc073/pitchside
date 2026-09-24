/* Pitchside service worker.
   Shell: stale-while-revalidate, so pages open instantly and pick up new code
   on the next load. Data: network first with a cache fallback, so a dropped
   connection (or an ESPN wobble) shows the last known scores instead of an
   error. */
const VERSION = 'v3';
const SHELL = `pitchside-shell-${VERSION}`;
const DATA = `pitchside-data-${VERSION}`;
const SHELL_FILES = ['./', './index.html', './styles.css', './app.js', './predictions.js', './predict-ui.js', './manifest.json'];
const DATA_HOSTS = /(espn\.com|espncdn\.com|wikipedia\.org|wikimedia\.org)$/;
const DATA_LIMIT = 300;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('pitchside-') && !k.endsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: false });
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
    return;
  }

  if (DATA_HOSTS.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res && res.ok) { cache.put(req, res.clone()); trim(DATA, DATA_LIMIT); }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
