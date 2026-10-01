// Service worker de /screen y /director: solo sirve el contenido precargado (/uploads/*).
// Se publica en /screen/media-sw.js y /director/media-sw.js (ver server.js) para que su
// ámbito cubra cada vista.
importScripts('/shared/media-sw-core.js');

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function(event) {
    var req = event.request;
    if (req.method !== 'GET') return;
    if (gsIsMedia(new URL(req.url))) event.respondWith(gsServeMedia(req));
});
