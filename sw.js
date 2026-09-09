/* İzlence service worker — uygulama kabuğu çevrimdışı, TMDB istekleri ağ-önce */
const VERSION = 'izlence-v1.5.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // TMDB afişleri: cache-first (değişmez içerik)
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(
      caches.open(VERSION + '-img').then((cache) =>
        cache.match(req).then((hit) => hit || fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit))
      )
    );
    return;
  }

  // TMDB API: network-only (anahtar içerdiği için önbelleklenmez)
  if (url.hostname === 'api.themoviedb.org') return;

  // Surum dosyasi: her zaman agdan, hic onbelleklenmez
  if (url.origin === self.location.origin && url.pathname.endsWith('/version.json')) return;

  // Uygulama kabugu (html/js/css): ag-once, cevrimdisiyken onbellekten.
  // Boylece yeni surum yayinlandiginda kullanici eski kabukta kalmaz.
  const isShell = url.origin === self.location.origin
    && (req.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname));
  if (isShell) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Diger ayni-kaynak varliklar: cache-first, arka planda tazele
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          caches.open(VERSION).then((c) => c.put(req, res.clone()));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || net;
    })
  );
});
