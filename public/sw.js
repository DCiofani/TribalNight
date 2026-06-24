// Service worker minimo: cache dell'app-shell + network-first per le navigazioni.
// NON intercetta le chiamate API/Realtime di Supabase (solo navigazioni) per non servire
// saldi/ticket stantii: lo stato vivo arriva sempre dal server via RPC + Realtime.
const CACHE = 'totem-night-v1';
const SHELL = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // tollerante: un precache fallito non deve bloccare l'attivazione del SW
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
  }
});
