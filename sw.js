/* İzlence service worker — uygulama kabuğu çevrimdışı, TMDB istekleri ağ-önce */
// Afişler değişmez: önbellekleri sürümden bağımsız tutulur, güncellemede silinmez.
// Sınırsız büyümesin diye en eski kayıtlar atılır.
const IMG_CACHE = 'izlence-img';
const IMG_MAX = 400;
let imgPuts = 0;
function trimImages(cache) {
  return cache.keys().then((keys) => (keys.length > IMG_MAX
    ? Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)))
    : null));
}

const VERSION = 'izlence-v1.8.2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './gizlilik.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMG_CACHE).map((k) => caches.delete(k))))
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
      caches.open(IMG_CACHE).then((cache) =>
        cache.match(req).then((hit) => hit || fetch(req).then((res) => {
          if (res.ok) {
            cache.put(req, res.clone()).then(() => { if (++imgPuts % 25 === 0) return trimImages(cache); }).catch(() => {});
          }
          return res;
        }).catch(() => hit))
      )
    );
    return;
  }

  // TMDB API: network-only (anahtar içerdiği için önbelleklenmez)
  if (url.hostname === 'api.themoviedb.org' || url.hostname.endsWith('.workers.dev')) return;

  // Surum dosyasi: her zaman agdan, hic onbelleklenmez
  if (url.origin === self.location.origin && url.pathname.endsWith('/version.json')) return;

  // Uygulama kabugu (html/js/css): ag-once, cevrimdisiyken onbellekten.
  // Boylece yeni surum yayinlandiginda kullanici eski kabukta kalmaz.
  const isShell = url.origin === self.location.origin
    && (req.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname));
  if (isShell) {
    e.respondWith(
      fetch(req).then((res) => {
        // kopya hemen alınmalı: sayfa gövdeyi okumaya başladıktan sonra clone() hata verir
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
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
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || net;
    })
  );
});
