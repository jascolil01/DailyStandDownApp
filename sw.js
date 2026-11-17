// Keeps a copy of the app's own files so it opens with no connection.
// Always tries the network first so updates show up straight away; the saved
// copy is only used when the network can't be reached. Supabase requests go
// to another site and are never touched here.
const CACHE = 'stand-down-v1';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'vendor/supabase.js',
  'icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
