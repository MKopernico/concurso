// Service Worker — GameShow /play (FASE 6)
// Cache-first para shell y assets estáticos. Precarga bajo demanda de assets de un juego
// (imágenes de preguntas, logos, fondos) vía mensaje 'PRECACHE_GAME' desde el cliente.

const CACHE_NAME = 'gameshow-play-v6';
const SHELL = [
    '/play/',
    '/play/index.html',
    '/play/manifest.json',
    '/socket.io/socket.io.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
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

    // For uploads (images/audio), use cache-first with network fallback
    if (url.pathname.startsWith('/uploads/')) {
        event.respondWith(
            caches.match(req).then(cached => {
                if (cached) return cached;
                return fetch(req).then(resp => {
                    if (resp && resp.ok) {
                        const copy = resp.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, copy));
                    }
                    return resp;
                });
            })
        );
        return;
    }

    // Shell and static: cache-first, update cache on fetch
    event.respondWith(
        caches.match(req).then(cached => {
            const fetchPromise = fetch(req).then(resp => {
                if (resp && resp.ok && url.origin === self.location.origin) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, copy));
                }
                return resp;
            }).catch(() => null);

            return cached || fetchPromise;
        })
    );
});

// Precache game assets on demand (called from client after selecting a game)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'PRECACHE_GAME') {
        const urls = event.data.urls || [];
        if (urls.length === 0) return;
        caches.open(CACHE_NAME).then(cache => {
            urls.forEach(url => {
                cache.match(url).then(existing => {
                    if (!existing) {
                        fetch(url).then(resp => {
                            if (resp && resp.ok) cache.put(url, resp);
                        }).catch(() => {});
                    }
                });
            });
        });
    }
});
