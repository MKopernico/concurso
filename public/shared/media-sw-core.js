// Núcleo compartido de los service workers: sirve /uploads/* desde la caché de precarga.
// Lo cargan con importScripts el SW de /play y el de /screen y /director.
//
// Vídeo y audio piden el archivo por trozos (cabecera Range); respondemos 206 con el trozo
// pedido a partir del archivo completo guardado. Si no está precargado, se va a la red.

function gsIsMedia(url) {
    return url.origin === self.location.origin && url.pathname.startsWith('/uploads/');
}

function gsRangeResponse(cached, rangeHeader) {
    return cached.blob().then(function(blob) {
        var m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (!m) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + blob.size } });
        var start, end;
        if (m[1] === '') { // sufijo: últimos N bytes
            start = Math.max(0, blob.size - Number(m[2]));
            end = blob.size - 1;
        } else {
            start = Number(m[1]);
            end = m[2] === '' ? blob.size - 1 : Math.min(Number(m[2]), blob.size - 1);
        }
        if (start >= blob.size || start > end) {
            return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + blob.size } });
        }
        var part = blob.slice(start, end + 1);
        return new Response(part, {
            status: 206,
            statusText: 'Partial Content',
            headers: {
                'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
                'Content-Length': String(part.size),
                'Content-Range': 'bytes ' + start + '-' + end + '/' + blob.size,
                'Accept-Ranges': 'bytes',
            },
        });
    });
}

function gsServeMedia(request) {
    return caches.match(request.url).then(function(cached) {
        if (!cached) return fetch(request);
        var range = request.headers.get('Range');
        return range ? gsRangeResponse(cached, range) : cached;
    }).catch(function() { return fetch(request); });
}
