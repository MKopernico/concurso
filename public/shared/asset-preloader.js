// Precarga verificada del contenido de un juego (imágenes, vídeos, audio) antes de jugar.
// Usado por /play, /screen y /director.
//
// - Pide al servidor la lista de archivos del dispositivo (url + tamaño + versión).
// - Descarga 4 a la vez; corta si un archivo se queda parado 15 s; reintenta 2 veces.
// - Verifica: respuesta correcta, tamaño exacto y, en imágenes, que se puedan abrir.
// - Guarda en Cache Storage (una caché por rol); el service worker sirve desde ahí.
//   Lo que ya está guardado con la misma versión se salta → reconectar es instantáneo.
// - Sin Cache Storage (http en red local) igualmente descarga y verifica: la caché HTTP del
//   navegador y la red local hacen el resto.
(function() {
    var CONCURRENCY = 4;
    var RETRIES = 2;
    var STALL_MS = 15000;
    var CACHE_PREFIX = 'gameshow-media-';

    var hasCache = !!(window.caches && window.isSecureContext);

    function fileName(url) {
        try { return decodeURIComponent(url.split('/').pop()); } catch (e) { return url.split('/').pop(); }
    }

    function fmtMB(bytes) {
        return (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
    }

    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    function fetchManifest(gameId, role, pass) {
        var url = '/api/games/' + encodeURIComponent(gameId) + '/assets?role=' + role + (pass ? '&pass=' + encodeURIComponent(pass) : '');
        return fetch(url, { cache: 'no-store' }).then(function(r) {
            if (!r.ok) { var e = new Error('lista ' + r.status); e.status = r.status; throw e; }
            return r.json();
        });
    }

    // Descarga leyendo por trozos: permite progreso por bytes y detectar descargas paradas.
    function download(file, onBytes) {
        var ctrl = new AbortController();
        var stallTimer = null;
        function arm() {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(function() { ctrl.abort(); }, STALL_MS);
        }
        arm();
        // Con Cache Storage guardamos nosotros la copia ('no-store'). Sin ella (kit por http://IP)
        // se deja en la caché HTTP del navegador ('no-cache': revalida, y si no ha cambiado
        // responde al instante), así el juego y las recargas no vuelven a descargarlo todo.
        return fetch(file.url, { cache: hasCache ? 'no-store' : 'no-cache', signal: ctrl.signal }).then(function(res) {
            if (!res.ok) { var e = new Error('El servidor respondió ' + res.status); e.fatal = res.status === 404; throw e; }
            var type = res.headers.get('Content-Type') || '';
            if (!res.body || !res.body.getReader) return res.blob().then(function(b) { onBytes(b.size); return b; });
            var reader = res.body.getReader();
            var chunks = [];
            function pump() {
                return reader.read().then(function(r) {
                    if (r.done) return new Blob(chunks, { type: type });
                    arm();
                    chunks.push(r.value);
                    onBytes(r.value.byteLength);
                    return pump();
                });
            }
            return pump();
        }).catch(function(err) {
            if (err.name === 'AbortError') throw new Error('La descarga se quedó parada (red lenta o cortada)');
            if (err instanceof TypeError) throw new Error('Sin conexión con el servidor');
            throw err;
        }).finally(function() { clearTimeout(stallTimer); });
    }

    // Comprueba que la imagen se puede abrir. createImageBitmap decodifica aunque la pestaña
    // esté oculta (un <img> en pestaña oculta puede no cargar nunca). SVG va por <img>.
    // Si la comprobación no responde en 10 s se da por buena: el tamaño ya coincidía.
    function verifyImage(blob) {
        var isSvg = /svg/i.test(blob.type);
        var check = (!isSvg && window.createImageBitmap)
            ? createImageBitmap(blob).then(function(bmp) { if (bmp.close) bmp.close(); }, function() { throw new Error('Imagen dañada'); })
            : verifyImageTag(blob);
        return Promise.race([check, wait(10000)]);
    }

    function verifyImageTag(blob) {
        return new Promise(function(resolve, reject) {
            var u = URL.createObjectURL(blob);
            var img = new Image();
            var done = function(ok) { URL.revokeObjectURL(u); ok ? resolve() : reject(new Error('Imagen dañada')); };
            img.onload = function() {
                if (img.decode) img.decode().then(function() { done(true); }, function() { done(img.naturalWidth > 0); });
                else done(img.naturalWidth > 0);
            };
            img.onerror = function() { done(false); };
            img.src = u;
        });
    }

    function processFile(file, cache, onBytes) {
        var got = 0;
        return download(file, function(n) { got += n; onBytes(n); }).then(function(blob) {
            if (blob.size !== file.size) throw new Error('Archivo incompleto (' + fmtMB(blob.size) + ' de ' + fmtMB(file.size) + ')');
            var check = file.kind === 'images' ? verifyImage(blob) : Promise.resolve();
            return check.then(function() {
                if (!cache) return;
                var headers = { 'Content-Type': blob.type || 'application/octet-stream', 'Content-Length': String(blob.size), 'X-GS-Ver': file.ver };
                return cache.put(file.url, new Response(blob, { headers: headers })).catch(function(err) {
                    if (err && err.name === 'QuotaExceededError') throw Object.assign(new Error('No queda espacio en el dispositivo'), { fatal: true });
                    throw err;
                });
            });
        }).catch(function(err) {
            onBytes(-got); // deshacer el progreso parcial antes de reintentar
            throw err;
        });
    }

    // files: [{url, kind, size, ver}] → Promise<{ok, failed:[{url, reason}]}>
    // prune: borrar de la caché lo que no esté en files (solo con la lista completa, no al reintentar)
    function run(files, role, onProgress, prune) {
        var state = { total: files.length, done: 0, bytesTotal: 0, bytes: 0, current: '' };
        files.forEach(function(f) { state.bytesTotal += f.size; });
        var failed = [];
        var queue = files.slice();
        var report = function() { if (onProgress) onProgress(state); };

        var openCache = hasCache ? caches.open(CACHE_PREFIX + role).catch(function() { return null; }) : Promise.resolve(null);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function() {});

        return openCache.then(function(cache) {
            function alreadyCached(file) {
                if (!cache) return Promise.resolve(false);
                return cache.match(file.url).then(function(r) { return !!r && r.headers.get('X-GS-Ver') === file.ver; });
            }

            function worker() {
                var file = queue.shift();
                if (!file) return Promise.resolve();
                state.current = fileName(file.url);
                report();
                return alreadyCached(file).then(function(hit) {
                    if (hit) { state.bytes += file.size; return; }
                    var attempt = function(n) {
                        return processFile(file, cache, function(b) { state.bytes += b; report(); }).catch(function(err) {
                            if (err.fatal || n >= RETRIES) throw err;
                            return wait(n === 0 ? 1000 : 3000).then(function() { return attempt(n + 1); });
                        });
                    };
                    return attempt(0);
                }).catch(function(err) {
                    failed.push({ url: file.url, reason: err.message || 'Error desconocido' });
                }).then(function() {
                    state.done++;
                    report();
                    return worker();
                });
            }

            var workers = [];
            for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
            return Promise.all(workers).then(function() {
                // Limpiar de la caché lo que ya no forma parte del juego
                if (cache && prune) {
                    var keep = {};
                    files.forEach(function(f) { keep[new URL(f.url, location.origin).href] = true; });
                    cache.keys().then(function(reqs) {
                        reqs.forEach(function(req) { if (!keep[req.url]) cache.delete(req); });
                    }).catch(function() {});
                }
                return { ok: state.total - failed.length, failed: failed };
            });
        });
    }

    // ───────────────── Pantalla de carga ─────────────────

    var CSS = ''
        + '.gsp-ov{position:fixed;inset:0;z-index:99999;background:rgba(10,10,16,.97);color:#e4e4e7;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
        + '.gsp-box{width:100%;max-width:520px;text-align:center;}'
        + '.gsp-title{font-size:24px;font-weight:700;margin-bottom:6px;}'
        + '.gsp-sub{font-size:15px;color:#9898a6;margin-bottom:24px;min-height:20px;}'
        + '.gsp-bar{height:14px;background:#25252f;border-radius:7px;overflow:hidden;}'
        + '.gsp-fill{height:100%;width:0;background:linear-gradient(90deg,#00a3c7,#00d4ff);transition:width .2s;}'
        + '.gsp-count{display:flex;justify-content:space-between;font-size:14px;color:#9898a6;margin-top:10px;font-variant-numeric:tabular-nums;}'
        + '.gsp-cur{font-size:12px;color:#6b6b78;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:16px;}'
        + '.gsp-err{display:none;text-align:left;margin-top:22px;}'
        + '.gsp-err h3{font-size:16px;color:#ef4444;margin-bottom:10px;}'
        + '.gsp-err ul{list-style:none;max-height:34vh;overflow-y:auto;background:#1c1c24;border:1px solid #33333d;border-radius:10px;padding:6px 12px;margin:0 0 8px;}'
        + '.gsp-err li{font-size:13px;padding:6px 0;border-bottom:1px solid #2a2a33;}'
        + '.gsp-err li:last-child{border-bottom:none;}'
        + '.gsp-err li b{display:block;color:#e4e4e7;word-break:break-all;}'
        + '.gsp-err li span{color:#9898a6;}'
        + '.gsp-note{font-size:12px;color:#9898a6;margin-bottom:8px;}'
        + '.gsp-btns{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}'
        + '.gsp-btns button{flex:1;min-width:160px;border:none;border-radius:10px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;}'
        + '.gsp-retry{background:#00d4ff;color:#000;}'
        + '.gsp-go{background:transparent;color:#e4e4e7;border:1px solid #33333d !important;}'
        + '.gsp-ok .gsp-fill{background:#22c55e;}';

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }

    // opts: { gameId, role, pass, title, onDone(result) }
    // result: { total, ok, failed:[{url,reason}], missing:[url], skipped:boolean }
    function showOverlay(opts) {
        if (!document.getElementById('gsp-style')) {
            var st = el('style'); st.id = 'gsp-style'; st.textContent = CSS; document.head.appendChild(st);
        }
        var ov = el('div', 'gsp-ov');
        var box = el('div', 'gsp-box');
        var title = el('div', 'gsp-title', esc(opts.title || 'Preparando el juego'));
        var sub = el('div', 'gsp-sub', 'Buscando contenido…');
        var bar = el('div', 'gsp-bar');
        var fill = el('div', 'gsp-fill');
        bar.appendChild(fill);
        var count = el('div', 'gsp-count', '<span></span><span></span>');
        var cur = el('div', 'gsp-cur');
        var err = el('div', 'gsp-err');
        var btns = el('div', 'gsp-btns');
        var retry = el('button', 'gsp-retry', '&#8635; Volver a descargar');
        var go = el('button', 'gsp-go', 'Continuar igualmente');
        btns.appendChild(retry); btns.appendChild(go);
        [title, sub, bar, count, cur, err].forEach(function(n) { box.appendChild(n); });
        box.appendChild(btns);
        btns.style.display = 'none';
        ov.appendChild(box);
        document.body.appendChild(ov);

        var manifest = null;
        var lastFailed = [];

        var autoTimer = null;
        function finish(result) {
            clearTimeout(autoTimer);
            ov.remove();
            if (opts.onDone) opts.onDone(result);
            if (opts.autoContinueMs && (result.failed.length || result.missing.length || !manifest)) showCornerNote(result);
        }

        // Con opts.autoContinueMs (proyector), los avisos se cierran solos y queda una nota pequeña
        function armAutoContinue() {
            if (!opts.autoContinueMs) return;
            clearTimeout(autoTimer);
            autoTimer = setTimeout(function() { finish(result(true)); }, opts.autoContinueMs);
            sub.textContent += ' · se continúa sola en ' + Math.round(opts.autoContinueMs / 1000) + ' s';
        }

        function showCornerNote(r) {
            var n = r.failed.length + r.missing.length;
            var note = el('div', null, '&#9888;&#65039; ' + (n ? n + ' archivo' + (n > 1 ? 's' : '') + ' sin descargar' : 'Precarga incompleta') + ' · ver coordinador');
            note.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99998;background:rgba(0,0,0,.75);color:#facc15;font:600 13px -apple-system,Segoe UI,Roboto,sans-serif;padding:8px 12px;border-radius:8px;border:1px solid rgba(250,204,21,.4);';
            document.body.appendChild(note);
            setTimeout(function() { note.remove(); }, 15000);
        }

        function result(skipped) {
            var files = manifest ? manifest.files : [];
            return {
                total: files.length,
                ok: files.length - lastFailed.length,
                failed: lastFailed,
                missing: manifest ? manifest.missing : [],
                skipped: !!skipped,
            };
        }

        function showErrors() {
            var html = '';
            if (lastFailed.length) {
                html += '<h3>No se han podido descargar ' + lastFailed.length + ' archivo' + (lastFailed.length > 1 ? 's' : '') + '</h3><ul>'
                    + lastFailed.map(function(f) { return '<li><b>' + esc(fileName(f.url)) + '</b><span>' + esc(f.reason) + '</span></li>'; }).join('')
                    + '</ul>';
            }
            if (manifest && manifest.missing.length) {
                html += '<h3>' + manifest.missing.length + ' archivo' + (manifest.missing.length > 1 ? 's no existen' : ' no existe') + ' en el servidor</h3>'
                    + '<div class="gsp-note">Reintentar no lo arregla: hay que volver a subirlo desde el backoffice.</div><ul>'
                    + manifest.missing.map(function(u) { return '<li><b>' + esc(fileName(u)) + '</b></li>'; }).join('')
                    + '</ul>';
            }
            err.innerHTML = html;
            err.style.display = 'block';
            retry.style.display = lastFailed.length || !manifest ? '' : 'none';
            btns.style.display = 'flex';
            cur.textContent = '';
            armAutoContinue();
        }

        function onProgress(s) {
            var pct = s.bytesTotal ? (s.bytes / s.bytesTotal) * 100 : (s.total ? (s.done / s.total) * 100 : 100);
            fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
            count.children[0].textContent = s.done + ' / ' + s.total + ' archivos';
            count.children[1].textContent = fmtMB(Math.max(0, s.bytes)) + ' / ' + fmtMB(s.bytesTotal);
            cur.textContent = s.done < s.total ? s.current : '';
        }

        function start(files) {
            ov.classList.remove('gsp-ok');
            err.style.display = 'none';
            btns.style.display = 'none';
            sub.textContent = 'Descargando contenido…';
            run(files, opts.role, onProgress, files === manifest.files).then(function(r) {
                // Al reintentar solo se descargan los fallidos: la lista total es la del manifiesto
                var retried = {};
                files.forEach(function(f) { retried[f.url] = true; });
                lastFailed = lastFailed.filter(function(f) { return !retried[f.url]; }).concat(r.failed);
                if (!lastFailed.length && !manifest.missing.length) {
                    ov.classList.add('gsp-ok');
                    fill.style.width = '100%';
                    sub.textContent = '¡Todo listo!';
                    setTimeout(function() { finish(result(false)); }, 500);
                } else {
                    sub.textContent = 'Algo no ha ido bien';
                    showErrors();
                }
            });
        }

        function load() {
            err.style.display = 'none';
            btns.style.display = 'none';
            sub.textContent = 'Buscando contenido…';
            fetchManifest(opts.gameId, opts.role, opts.pass).then(function(m) {
                manifest = m;
                lastFailed = [];
                start(m.files);
            }).catch(function(e) {
                // El código del juego cambió: no es un problema de WiFi, hay que volver a meterlo
                if (e && e.status === 403 && opts.onPassRejected) { clearTimeout(autoTimer); ov.remove(); opts.onPassRejected(); return; }
                manifest = null;
                sub.textContent = 'No se pudo obtener la lista de contenido';
                err.innerHTML = '<h3>Sin conexión con el servidor</h3><div class="gsp-note">Comprueba la WiFi y vuelve a intentarlo.</div>';
                err.style.display = 'block';
                retry.style.display = '';
                btns.style.display = 'flex';
                armAutoContinue();
            });
        }

        retry.onclick = function() {
            clearTimeout(autoTimer);
            if (!manifest) { load(); return; }
            var again = {};
            lastFailed.forEach(function(f) { again[f.url] = true; });
            start(manifest.files.filter(function(f) { return again[f.url]; }));
        };
        go.onclick = function() { finish(result(true)); };

        load();
    }

    // Resumen compacto para enviar al coordinador (B6)
    function summary(r) {
        return {
            total: r.total,
            ok: r.ok,
            failed: r.failed.length,
            missing: r.missing.length,
            names: r.failed.map(function(f) { return fileName(f.url); }).concat(r.missing.map(fileName)).slice(0, 20),
            skipped: r.skipped,
        };
    }

    window.GSPreload = { showOverlay: showOverlay, run: run, fetchManifest: fetchManifest, summary: summary, hasCache: hasCache };
})();
