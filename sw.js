// FlyEye — service worker (punto 3)
// A ogni nuova versione dell'app cambiare VERSIONE: è così che il telefono
// capisce che deve scaricare i file nuovi.
// Le mappe NON stanno qui: sono in IndexedDB ("flyeye-dati") e non vengono
// mai toccate dagli aggiornamenti dell'app.
const VERSIONE = '0.3.0';
const CACHE_APP = 'flyeye-app-' + VERSIONE;

// Tutti i file dell'app. Ogni file nuovo va aggiunto qui.
const FILE_APP = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './archivio.js',
  './mappa.js',
  './lib/maplibre-gl.js',
  './lib/maplibre-gl.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE_APP)
      .then((cache) => cache.addAll(FILE_APP.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    // Elimina solo le vecchie cache dell'app (i dati mappa sono in IndexedDB)
    const nomi = await caches.keys();
    await Promise.all(
      nomi.filter((n) => n.startsWith('flyeye-app-') && n !== CACHE_APP)
          .map((n) => caches.delete(n))
    );
    await self.clients.claim();
    const clienti = await self.clients.matchAll({ type: 'window' });
    clienti.forEach((c) => c.postMessage({ tipo: 'cache-pronta', versione: VERSIONE }));
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tile EOX e altro: non passano dalla cache

  // Apertura pagina: sempre index.html dalla cache (funziona senza rete)
  if (req.mode === 'navigate') {
    ev.respondWith(
      caches.match('./index.html', { ignoreSearch: true })
        .then((r) => r || fetch(req))
    );
    return;
  }

  // Altri file: prima la cache, poi la rete
  ev.respondWith(
    caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req))
  );
});
