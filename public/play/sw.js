// Service Worker — GameShow /play
// - Shell y estáticos: primero la red (actualizaciones a la primera); copia guardada si no hay red.
// - Contenido del juego (/uploads/*): lo descarga y verifica la pantalla de precarga
//   (shared/asset-preloader.js) en su propia caché; aquí solo se sirve desde ella.
importScripts('/shared/media-sw-core.js');

const CACHE_NAME = 'gameshow-play-v45';
const SHELL = [
    '/play/',
    '/play/index.html',
    '/play/manifest.json',
    '/socket.io/socket.io.js',
    '/play/frost.png',
    '/shared/karaoke-colors.js',
    '/shared/asset-preloader.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            // Las cachés de contenido (gameshow-media-*) sobreviven a las actualizaciones de la app
            Promise.all(keys.filter(k => k !== CACHE_NAME && !k.startsWith('gameshow-media-')).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // Never cache Socket.io transport, API calls, or health-check
    if (url.pathname.startsWith('/socket.io') && url.pathname !== '/socket.io/socket.io.js') return;
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname === '/ping') return;
    if (req.method !== 'GET') return;

    if (gsIsMedia(url)) {
        event.respondWith(gsServeMedia(req));
        return;
    }

    // Shell y estáticos: primero la red (así una actualización se ve a la primera), guardando copia.
    // Si la red falla o tarda más de 4 s (WiFi mala), se sirve la copia guardada.
    event.respondWith(networkFirst(req, url));
});

function networkFirst(req, url) {
    const network = fetch(req).then(resp => {
        if (resp && resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return resp;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, 4000));
    return Promise.race([network.catch(() => null), timeout]).then(resp => {
        if (resp) return resp;
        return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(cached => cached || network);
    });
}
