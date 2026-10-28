// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-spotify.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos) y un «Spotify de
// mentira» (cuentas + Web API) en otro puerto. Comprueba: preparar y conectar la cuenta (PKCE,
// permisos, vuelta al backoffice, conexión cifrada), lo que ve el coordinador, elegir fuente,
// órdenes del panel, sintonía con Spotify (fundido hasta callar → sintonía entera → vuelve con
// fundido), pausa automática con «Adivina la canción» y vídeo, sin reproductor activo, sin
// Premium, renovación y caducidad de la conexión, iPads sin acceso y el kit offline (no aparece).
// Versión ampliada: avance (sin avisar cada 4 s), saltar a un punto, aleatorio/repetir, canciones de
// una lista propia (las ajenas no se ven), tocar una canción, cola, «▶ Ya», buscar, mover y añadir a
// listas, y las conexiones antiguas sin el permiso de cambiar listas.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3243, FAKE = 3244;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-spotify');
const PW = 'pruebas-' + crypto.randomBytes(6).toString('hex');
const CLIENT = 'abcdef0123456789abcdef0123456789';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

// ───────────── Spotify de mentira ─────────────
const sp = {
    calls: [], codes: new Map(), access: new Set(), refresh: new Set(),
    premium: true, device: true, active: true, expireNext: false, failRefresh: false,
    player: { is_playing: true, volume: 60, track: 'Canción de prueba', uri: 'spotify:track:T000000000000', context: null, pos: 0, posAt: Date.now(), shuffle: false, repeat: 'off' },
    narrowScope: false, queue: [],
};
// Canciones y listas del Spotify de mentira (la C es de otra cuenta: no se ve por dentro)
const TR = (i) => ({ uri: 'spotify:track:T' + String(i).padStart(12, '0'), name: 'Tema ' + i, artists: [{ name: 'Grupo ' + i }], duration_ms: 180000 + i * 1000, album: { images: [{ url: 'https://i.scdn.co/image/a' + i }] } });
sp.lists = {
    AAAAAAAAAAAAAAAAAAAAAA: { name: 'Fiesta', owner: 'kopernico', tracks: [1, 2, 3, 4, 5].map(TR), snap: 1 },
    BBBBBBBBBBBBBBBBBBBBBB: { name: 'Del juego', owner: 'kopernico', tracks: [6, 7].map(TR), snap: 1 },
    CCCCCCCCCCCCCCCCCCCCCC: { name: 'Éxitos', owner: 'spotify', tracks: [8].map(TR), snap: 1 },
};
const posNow = () => sp.player.pos + (sp.player.is_playing ? Date.now() - sp.player.posAt : 0);
function spReset() { sp.calls = []; }
function spCalls(re) { return sp.calls.filter(c => re.test(c.method + ' ' + c.path)); }
const fakeSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        const send = (st, obj) => { res.writeHead(st, obj ? { 'Content-Type': 'application/json' } : {}); res.end(obj ? JSON.stringify(obj) : ''); };
        const call = { method: req.method, path: url.pathname + url.search, body, t: Date.now() };
        if (url.pathname === '/api/token') {
            const p = new URLSearchParams(body);
            call.params = Object.fromEntries(p);
            sp.calls.push(call);
            if (p.get('grant_type') === 'authorization_code') {
                const c = sp.codes.get(p.get('code'));
                const ok = c && p.get('client_id') === CLIENT && p.get('redirect_uri') === c.redirect &&
                    crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') === c.challenge;
                if (!ok) return send(400, { error: 'invalid_grant' });
                const at = 'AT-' + crypto.randomBytes(6).toString('hex'), rt = 'RT-SECRETO-' + crypto.randomBytes(6).toString('hex');
                sp.access.add(at); sp.refresh.add(rt);
                // Spotify dice qué permisos se dieron (una conexión antigua no tenía los de cambiar listas)
                const scope = sp.narrowScope ? c.scope.split(' ').filter(x => !/modify-p/.test(x)).join(' ') : c.scope;
                return send(200, { access_token: at, refresh_token: rt, expires_in: 3600, scope });
            }
            if (p.get('grant_type') === 'refresh_token') {
                if (sp.failRefresh || !sp.refresh.has(p.get('refresh_token'))) return send(400, { error: 'invalid_grant' });
                const at = 'AT-' + crypto.randomBytes(6).toString('hex');
                sp.access.add(at);
                return send(200, { access_token: at, expires_in: 3600 });
            }
            return send(400, { error: 'unsupported_grant_type' });
        }
        sp.calls.push(call);
        const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (sp.expireNext) { sp.expireNext = false; sp.access.delete(tok); }
        if (!sp.access.has(tok)) return send(401, { error: { status: 401, message: 'The access token expired' } });
        const p = url.pathname.replace(/^\/v1/, '');
        if (p === '/me') return send(200, { id: 'kopernico', display_name: 'Kopérnico' });
        if (p === '/me/playlists') return send(200, { items: Object.keys(sp.lists).map(id => ({ uri: 'spotify:playlist:' + id, name: sp.lists[id].name, images: [], owner: { id: sp.lists[id].owner }, collaborative: false, items: { total: sp.lists[id].tracks.length } })) });
        let m;
        if ((m = p.match(/^\/playlists\/([A-Z]+)(\/items)?$/))) {
            const L = sp.lists[m[1]];
            if (!L) return send(404, { error: { status: 404, message: 'no existe' } });
            const own = L.owner === 'kopernico';
            if (!m[2]) return send(200, { name: L.name, owner: { id: L.owner }, collaborative: false, snapshot_id: 'snap' + L.snap, images: [] });
            if (req.method === 'GET') {
                if (!own) return send(403, { error: { status: 403, message: 'Forbidden' } });
                const off = Number(url.searchParams.get('offset')) || 0, lim = Number(url.searchParams.get('limit')) || 20;
                return send(200, { total: L.tracks.length, snapshot_id: 'snap' + L.snap, items: L.tracks.slice(off, off + lim).map(t => ({ item: t })) });
            }
            if (!own) return send(403, { error: { status: 403, message: 'Forbidden' } });
            const b = JSON.parse(body || '{}');
            if (req.method === 'PUT') {
                const t = L.tracks.splice(b.range_start, 1)[0];
                L.tracks.splice(b.insert_before > b.range_start ? b.insert_before - 1 : b.insert_before, 0, t);
            } else if (req.method === 'POST') (b.uris || []).forEach(u => L.tracks.push({ ...TR(Number(u.slice(-12))), uri: u }));
            L.snap++;
            return send(200, { snapshot_id: 'snap' + L.snap });
        }
        if (p === '/search') {
            const q = url.searchParams.get('q'), off = Number(url.searchParams.get('offset')) || 0, lim = Number(url.searchParams.get('limit'));
            const all = Array.from({ length: 23 }, (_, i) => TR(100 + i)).map(t => ({ ...t, name: q + ' ' + t.name }));
            return send(200, { tracks: { total: all.length, items: all.slice(off, off + lim) } });
        }
        if (p === '/me/player/devices') return send(200, { devices: sp.device ? [{ id: 'pc-sala', name: 'PC-SALA', type: 'Computer', is_restricted: false, volume_percent: sp.player.volume }] : [] });
        if (!sp.premium && req.method !== 'GET') return send(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
        const devId = url.searchParams.get('device_id');
        if (devId === 'pc-sala') sp.active = true;
        if (p === '/me/player' && req.method === 'GET') {
            if (!sp.device || !sp.active) return send(204);
            return send(200, { is_playing: sp.player.is_playing, progress_ms: Math.round(posNow()), shuffle_state: sp.player.shuffle, repeat_state: sp.player.repeat,
                device: { id: 'pc-sala', name: 'PC-SALA', type: 'Computer', is_restricted: false, supports_volume: true, volume_percent: sp.player.volume },
                item: { name: sp.player.track, uri: sp.player.uri, duration_ms: 200000, artists: [{ name: 'Artista' }], album: { images: [{ url: 'https://i.scdn.co/image/grande' }, { url: 'https://i.scdn.co/image/peque' }] } }, context: sp.player.context ? { uri: sp.player.context } : null });
        }
        if (!sp.device || !sp.active) return send(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
        if (p === '/me/player/volume') { sp.player.volume = Number(url.searchParams.get('volume_percent')); return send(204); }
        if (p === '/me/player/pause') { sp.player.pos = posNow(); sp.player.is_playing = false; return send(204); }
        if (p === '/me/player/play') {
            if (!sp.player.is_playing) sp.player.posAt = Date.now();
            sp.player.is_playing = true;
            try {
                const b = JSON.parse(body || '{}');
                if (b.context_uri) sp.player.context = b.context_uri;
                const u = (b.offset && b.offset.uri) || (b.uris && b.uris[0]);
                if (u) { sp.player.uri = u; sp.player.track = 'Tema ' + Number(u.slice(-12)); sp.player.pos = 0; sp.player.posAt = Date.now(); }
            } catch {}
            return send(204);
        }
        if (p === '/me/player/seek') { sp.player.pos = Number(url.searchParams.get('position_ms')); sp.player.posAt = Date.now(); return send(204); }
        if (p === '/me/player/shuffle') { sp.player.shuffle = url.searchParams.get('state') === 'true'; return send(204); }
        if (p === '/me/player/repeat') { sp.player.repeat = url.searchParams.get('state'); return send(204); }
        if (p === '/me/player/queue' && req.method === 'POST') { sp.queue.push(url.searchParams.get('uri')); return send(204); }
        if (p === '/me/player/queue') return send(200, { currently_playing: { name: sp.player.track, uri: sp.player.uri, duration_ms: 200000, artists: [{ name: 'Artista' }] }, queue: sp.queue.map(u => TR(Number(u.slice(-12)))).concat([TR(50)]) });
        if (p === '/me/player/next') {
            const u = sp.queue.shift();
            if (u) { sp.player.uri = u; sp.player.track = 'Tema ' + Number(u.slice(-12)); } else sp.player.track = 'Siguiente canción';
            return send(204);
        }
        if (p === '/me/player/previous') { sp.player.track = 'Canción anterior'; return send(204); }
        send(404, { error: { status: 404, message: 'no existe' } });
    });
});

// ───────────── GameShow ─────────────
async function startServer(extraEnv) {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW,
        SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${FAKE}`, SPOTIFY_API_BASE: `http://127.0.0.1:${FAKE}/v1`, ...(extraEnv || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}
async function stopServer() { server.kill(); await new Promise(r => server.once('exit', r)); }
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: opts.noCookie ? '' : cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc && !opts.noCookie) cookie = sc.split(';')[0];
    const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch {}
    return { status: res.status, data, location: res.headers.get('location') };
}
async function uploadAudio(name) {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(2048, 7)], { type: 'audio/mpeg' }), name);
    return (await (await fetch(B + '/api/upload/audio', { method: 'POST', body: fd, headers: { cookie } })).json()).url;
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));
function director(gameId) {
    const d = io(B, { query: { gameId }, transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    d.lists = null; d.on('game:spotify_lists', l => { d.lists = l; });
    d.syncs = 0; d.on('game:director_sync', () => { d.syncs++; });
    // Consulta de la versión ampliada: espera la respuesta con su id
    let n = 0;
    d.req = (op, params) => new Promise(res => {
        const id = 'q' + (++n);
        const h = (r) => { if (r.id === id) { d.off('game:spotify_res', h); res(r); } };
        d.on('game:spotify_res', h);
        d.emit('director:spotify_req', { id, op, ...(params || {}) });
        setTimeout(() => { d.off('game:spotify_res', h); res(null); }, 4000);
    });
    return d;
}
function screen(gameId) {
    const s = io(B, { query: { gameId }, transports: ['websocket'], forceNew: true });
    s.sync = null; s.jingles = [];
    s.on('game:player_sync', v => { s.sync = v; });
    s.on('game:jingle', j => { j.t = Date.now(); s.jingles.push(j); });
    s.on('connect', () => s.emit('screen:join', { embed: false }));
    return s;
}
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(50); } return false; }
const vols = (calls) => calls.filter(c => /\/me\/player\/volume/.test(c.path)).map(c => Number(new URL(c.path, 'http://x').searchParams.get('volume_percent')));

// Da permiso como lo haría el navegador: login → Spotify → callback
async function connectAccount() {
    const r = await api('/spotify/login');
    const loc = new URL(r.location);
    const code = 'CODE-' + crypto.randomBytes(4).toString('hex');
    sp.codes.set(code, { challenge: loc.searchParams.get('code_challenge'), redirect: loc.searchParams.get('redirect_uri'), scope: loc.searchParams.get('scope') || '' });
    return { login: r, loc, back: await api('/spotify/callback?code=' + code + '&state=' + loc.searchParams.get('state')) };
}

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await new Promise(r => fakeSrv.listen(FAKE, '127.0.0.1', r));
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });

    // ── Preparar y conectar (backoffice) ──
    check('Sin sesión no se ve nada de Spotify', (await api('/spotify/status', { noCookie: true })).status === 401);
    let st = (await api('/spotify/status')).data;
    check('Disponible, sin preparar, con la dirección de vuelta para pegar en Spotify', st.enabled === true && st.connected === false && st.clientId === '' && st.redirectUri === `${B}/api/spotify/callback` && st.warning === null, st);
    const lh = await fetch(`http://localhost:${PORT}/api/spotify/status`, { headers: { cookie } }).then(r => r.json());
    check('Con «localhost» avisa de que Spotify no lo admite (hay que usar 127.0.0.1)', /127\.0\.0\.1/.test(lh.warning || ''), lh.warning);
    check('Client ID mal escrito: no se guarda', (await api('/spotify/config', { method: 'PUT', body: { clientId: 'hola' } })).status === 400);
    check('Client ID bueno: se guarda', (await api('/spotify/config', { method: 'PUT', body: { clientId: CLIENT } })).status === 200 && (await api('/spotify/status')).data.clientId === CLIENT);

    const { login, loc, back } = await connectAccount();
    const scopes = (loc.searchParams.get('scope') || '').split(' ');
    check('«Conectar» manda a Spotify con PKCE y solo los permisos necesarios (también cambiar listas propias)', login.status === 302 && loc.origin === `http://127.0.0.1:${FAKE}` && loc.pathname === '/authorize' &&
        loc.searchParams.get('client_id') === CLIENT && loc.searchParams.get('code_challenge_method') === 'S256' && loc.searchParams.get('redirect_uri') === `${B}/api/spotify/callback` &&
        scopes.length === 7 && ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing', 'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public'].every(x => scopes.includes(x)), loc.search);
    check('Al volver de Spotify se guarda la conexión y vuelve al backoffice con «ok»', back.status === 302 && back.location === '/admin/?spotify=ok', back.location);
    st = (await api('/spotify/status')).data;
    const lifeDays = (st.expiresAt - st.connectedAt) / 86400000;
    check('Conectado con el nombre de la cuenta y fecha de caducidad (~6 meses)', st.connected && st.user === 'Kopérnico' && lifeDays > 180 && lifeDays < 186, { user: st.user, lifeDays });
    check('El estado nunca enseña llaves', !/RT-|AT-/.test(JSON.stringify(st)));
    const bad = await api('/spotify/callback?code=x&state=inventado');
    check('Una vuelta que no viene de «Conectar» se rechaza', bad.status === 302 && /caducado|no viene/.test(decodeURIComponent(bad.location)), bad.location);
    {
        const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
        const dbf = fs.readdirSync(DATA, { recursive: true }).map(f => path.join(DATA, String(f))).find(f => /\.db$/.test(f));
        const row = new Database(dbf, { readonly: true }).prepare("SELECT value FROM settings WHERE key = 'spotify'").get();
        check('La conexión se guarda cifrada en el servidor (no se lee la llave)', row && !/RT-SECRETO/.test(row.value) && JSON.parse(row.value).rt, row && row.value.slice(0, 60));
    }
    const pl = (await api('/spotify/playlists')).data;
    check('El backoffice puede listar las listas de la cuenta', pl.items && pl.items[0].name === 'Fiesta' && pl.items[0].uri === 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', pl);

    // ── Juego con sintonía, «Adivina la canción» y lista de Spotify ──
    const jBoom = await uploadAudio('Sintonia boom.mp3');
    const jPul = await uploadAudio('Sintonia pulsador.mp3');
    const theme = { types: { boom: { jingle: jBoom }, pulsador: { jingle: jPul } }, sound: { max: 8 }, musicSource: 'spotify', spotifyPlaylist: 'spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB' };
    const g = (await api('/games', { method: 'POST', body: { name: 'Spotify', status: 'published', theme } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rBoom = await mk('Boom', 'boom', { time: 30 }, [{ statement: 'Ordena', items: ['a', 'b'], correctOrder: [0, 1] }]);
    const rPul = await mk('Pulsa', 'pulsador', {}, [{ statement: 'P3', answer: 'z' }]);
    const rCan = await mk('Canción', 'cancion', { jingle: 'none' }, [{ statement: '¿Qué canción?', answer: 'x' }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = director(g.id);
    await connected(d);
    check('Al entrar el coordinador ya ve lo que suena (sin esperar a que pase algo en el juego)', await until(() => d.state && d.state.spotify && d.state.spotify.player, 3000));
    const S = screen(g.id);
    await connected(S); await wait(300);
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const p = io(B, { query: { gameId: g.id, deviceId: 'ipad1', pass }, transports: ['websocket'], forceNew: true });
    p.sync = null; p.on('game:player_sync', v => { p.sync = v; });
    await connected(p); p.emit('player:register_team', { name: 'Equipo 1', deviceId: 'ipad1' }); await wait(400);

    check('El juego empieza con Spotify como fuente (lo dice el backoffice)', d.state.director.sound.source === 'spotify' && S.sync.sound.src === 'spotify', d.state.director.sound.source);
    await until(() => d.state.spotify && d.state.spotify.player);
    const v0 = d.state.spotify;
    check('El coordinador ve lo que suena en Spotify (canción, portada pequeña, volumen, ordenador)', v0.enabled && v0.connected && v0.player && v0.player.track === 'Canción de prueba' && v0.player.image === 'https://i.scdn.co/image/peque' && v0.player.volume === 60 && v0.player.deviceName === 'PC-SALA', v0);
    check('Ni la pantalla ni los iPads reciben nada de Spotify', !('spotify' in S.sync) && !('spotify' in p.sync) && p.sync.sound === null);

    // ── Sintonía con Spotify sonando ──
    spReset();
    d.emit('director:launch_round', { roundId: rBoom.id });
    await until(() => S.jingles.length === 1);
    const pauseCall = spCalls(/pause/)[0];
    const downs = vols(sp.calls.filter(c => pauseCall && c.t <= pauseCall.t));
    check('Con una sintonía, Spotify baja por pasos hasta callar y se pausa', pauseCall && downs.length === 5 && downs[4] === 0 && downs[0] < 60 && downs.every((v, i) => i === 0 || v <= downs[i - 1]), downs);
    check('…y la sintonía llega a la pantalla después, entera (sin fundido de entrada)', S.jingles[0] && S.jingles[0].url === jBoom && S.jingles[0].cut === true && pauseCall && S.jingles[0].t >= pauseCall.t, S.jingles[0]);
    check('La espera hasta que entra la sintonía es corta (≤ 2,5 s)', S.jingles[0] && S.jingles[0].t - pauseCall.t < 1000 && pauseCall.t - sp.calls[0].t < 2500);
    await wait(300);
    check('En pausa, el volumen de Spotify se deja como estaba (por si algo falla, no se queda a cero)', sp.player.volume === 60 && sp.player.is_playing === false, sp.player);
    await until(() => d.state.spotify.held);
    check('El coordinador ve «en pausa automática»', d.state.spotify.held === true);
    spReset();
    S.emit('screen:jingle_end', { id: S.jingles[0].id });
    await until(() => vols(sp.calls).length >= 6 && spCalls(/play/).length);
    await wait(200);
    const ups = vols(sp.calls);
    const playIdx = sp.calls.findIndex(c => /\/me\/player\/play/.test(c.path));
    check('Al acabar la sintonía, Spotify vuelve: volumen a 0, play y sube por pasos hasta el que tenía', ups[0] === 0 && playIdx > 0 && ups.length === 6 && ups[5] === 60 && ups.slice(1).every((v, i, a) => i === 0 || v >= a[i - 1]), ups);
    await until(() => !d.state.spotify.held);
    check('…y el panel vuelve a «sonando»', d.state.spotify.held === false && sp.player.is_playing === true);

    // ── Sintonía sin Spotify sonando ──
    sp.player.is_playing = false; await wait(4500); spReset();
    d.emit('director:launch_round', { roundId: rPul.id });
    await until(() => S.jingles.length === 2);
    check('Con Spotify en pausa, la sintonía suena enseguida (con su fundido) y Spotify no se toca', S.jingles[1].url === jPul && S.jingles[1].cut === false && !spCalls(/\/me\/player\/(pause|play|volume)/).length, S.jingles[1]);
    sp.player.is_playing = true; await wait(4500);

    // ── Órdenes del panel ──
    spReset();
    d.emit('director:sound', { action: 'sp_next' }); await until(() => d.state.spotify.player && d.state.spotify.player.track === 'Siguiente canción');
    check('⏭ pasa a la siguiente canción', spCalls(/POST \/v1\/me\/player\/next/).length === 1 && d.state.spotify.player.track === 'Siguiente canción');
    d.emit('director:sound', { action: 'sp_vol', value: 40 }); await until(() => sp.player.volume === 40 && d.state.spotify.player.volume === 40);
    check('El volumen del panel cambia el de Spotify', sp.player.volume === 40 && d.state.spotify.player.volume === 40);
    d.emit('director:sound', { action: 'sp_toggle' }); await until(() => !sp.player.is_playing);
    check('❚❚ pausa Spotify', sp.player.is_playing === false);
    d.emit('director:sound', { action: 'sp_playlist', uri: 'https://open.spotify.com/playlist/BBBBBBBBBBBBBBBBBBBBBB?si=123' }); await until(() => sp.player.is_playing);
    check('Elegir una lista (también pegando el enlace) la pone a sonar', sp.player.context === 'spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB' && sp.player.is_playing, sp.player.context);
    d.emit('director:spotify_lists'); await until(() => d.lists);
    check('El panel recibe las listas de la cuenta', d.lists && d.lists.items && d.lists.items[0].name === 'Fiesta');
    spReset();
    d.emit('director:sound', { action: 'sp_playlist', uri: 'javascript:alert(1)' }); await wait(500);
    check('Un enlace que no es de Spotify no hace nada', !spCalls(/\/me\/player\/play/).length);

    // ── Versión ampliada del panel ──
    sp.player.track = 'Canción de prueba'; sp.player.uri = 'spotify:track:T000000000000';
    await wait(4500);
    const vx = d.state.spotify;
    check('Ampliada: el coordinador ve avance, duración, aleatorio, repetir, portada grande y la hora del servidor', vx.canEdit === true && vx.player.durationMs === 200000 && vx.player.progressMs > 0 &&
        vx.player.shuffle === false && vx.player.repeat === 'off' && vx.player.imageBig === 'https://i.scdn.co/image/peque' && vx.player.trackUri === 'spotify:track:T000000000000' && vx.player.at > 0 && Math.abs(vx.now - Date.now()) < 3000, vx.player);
    const s0 = d.syncs; await wait(9000);
    check('Mientras la canción avanza sin más, no se avisa al coordinador cada 4 s (el panel cuenta solo)', d.syncs - s0 <= 1, d.syncs - s0);
    spReset();
    d.emit('director:sound', { action: 'sp_seek', ms: 61000 });
    await until(() => d.state.spotify.player.progressMs >= 61000 && d.state.spotify.player.progressMs < 70000);
    check('Arrastrar la barra salta a ese punto de la canción (y el panel se entera)', spCalls(/PUT \/v1\/me\/player\/seek\?position_ms=61000$/).length === 1 && d.state.spotify.player.progressMs >= 61000, d.state.spotify.player.progressMs);
    d.emit('director:sound', { action: 'sp_shuffle', value: true }); await until(() => d.state.spotify.player.shuffle === true);
    d.emit('director:sound', { action: 'sp_repeat', value: 'context' }); await until(() => d.state.spotify.player.repeat === 'context');
    check('Aleatorio y repetir lista', d.state.spotify.player.shuffle === true && d.state.spotify.player.repeat === 'context' && sp.player.shuffle === true);
    spReset();
    d.emit('director:sound', { action: 'sp_repeat', value: 'loco' }); d.emit('director:sound', { action: 'sp_seek', ms: -5 }); await wait(500);
    check('Un modo de repetir inventado o un punto negativo no se mandan', !spCalls(/repeat|seek/).length);
    const it = await d.req('items', { uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA' });
    check('Pestaña «Lista»: canciones de una lista propia (nombre, artista, duración, se puede cambiar)', it && it.ok && it.data.name === 'Fiesta' && it.data.editable === true && it.data.total === 5 &&
        it.data.items.length === 5 && it.data.items[2].name === 'Tema 3' && it.data.items[2].artist === 'Grupo 3' && it.data.items[2].ms === 183000 && it.data.snapshot === 'snap1', it && (it.data || it.error));
    const ajena = await d.req('items', { uri: 'spotify:playlist:CCCCCCCCCCCCCCCCCCCCCC' });
    check('Una lista de otra cuenta no se ve por dentro (aviso claro: se puede poner entera)', ajena && ajena.error && /creadas por esta cuenta/.test(ajena.error), ajena && ajena.error);
    spReset();
    d.emit('director:sound', { action: 'sp_track', uri: 'spotify:track:T000000000003', context: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA' });
    await until(() => d.state.spotify.player.track === 'Tema 3');
    const tp = spCalls(/PUT \/v1\/me\/player\/play/)[0];
    check('Tocar una canción de la lista la pone desde ahí (dentro de la lista, sigue con las siguientes)', tp && JSON.parse(tp.body).context_uri === 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA' && JSON.parse(tp.body).offset.uri === 'spotify:track:T000000000003', tp && tp.body);
    spReset();
    d.emit('director:sound', { action: 'sp_track', uri: 'spotify:album:XXXXXXXXXXXXXXXXXXXXXX' }); await wait(500);
    check('Algo que no es una canción no se toca', !spCalls(/\/me\/player\/play/).length);
    d.emit('director:sound', { action: 'sp_queue', uri: 'spotify:track:T000000000009' }); await until(() => sp.queue.length === 1);
    const qq = await d.req('queue');
    check('«＋ Cola» la añade a la cola y la pestaña «Cola» la enseña la primera, tras lo que suena', sp.queue[0] === 'spotify:track:T000000000009' && qq && qq.ok && qq.data.current.name === 'Tema 3' && qq.data.items[0].name === 'Tema 9', qq && qq.data);
    sp.queue = []; spReset();
    d.emit('director:sound', { action: 'sp_now', uri: 'spotify:track:T000000000004' });
    await until(() => d.state.spotify.player.track === 'Tema 4');
    const qi = sp.calls.findIndex(c => /POST \/v1\/me\/player\/queue/.test(c.method + ' ' + c.path)), ni = sp.calls.findIndex(c => /POST \/v1\/me\/player\/next/.test(c.method + ' ' + c.path));
    check('«▶ Ya»: a la cola y salta a ella (después sigue la lista que sonaba)', qi >= 0 && ni > qi && d.state.spotify.player.track === 'Tema 4' && sp.player.context === 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA');
    spReset();
    const sr = await d.req('search', { q: 'fiesta' });
    const sr2 = await d.req('search', { q: 'fiesta', offset: 20 });
    check('Buscar: de 10 en 10 (lo que deja Spotify) y «Más resultados»', sr && sr.ok && sr.data.items.length === 10 && sr.data.total === 23 && /fiesta Tema 100/.test(sr.data.items[0].name) &&
        sr2.data.items.length === 3 && spCalls(/GET \/v1\/search\?type=track&limit=10&offset=0&q=fiesta$/).length === 1, sr && sr.data && sr.data.total);
    spReset();
    const empty = await d.req('search', { q: '   ' });
    check('Una búsqueda vacía no pregunta a Spotify', empty && empty.ok && empty.data.items.length === 0 && !sp.calls.length);
    const mv = await d.req('reorder', { uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', from: 0, to: 3, snapshot: 'snap1' });
    const mvc = spCalls(/PUT \/v1\/playlists\/AAAAAAAAAAAAAAAAAAAAAA\/items/)[0];
    check('Mover una canción en una lista propia (la 1.ª pasa a 3.ª) y devuelve la versión nueva', mv && mv.ok && mv.data.snapshot === 'snap2' && sp.lists.AAAAAAAAAAAAAAAAAAAAAA.tracks.map(t => t.name.slice(5)).join('') === '23145' &&
        mvc && JSON.parse(mvc.body).range_start === 0 && JSON.parse(mvc.body).insert_before === 3 && JSON.parse(mvc.body).snapshot_id === 'snap1', mv && (mv.data || mv.error));
    const add = await d.req('add', { uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', track: 'spotify:track:T000000000102' });
    check('«＋ Lista»: añade una canción a una lista propia', add && add.ok && sp.lists.AAAAAAAAAAAAAAAAAAAAAA.tracks.length === 6 && sp.lists.AAAAAAAAAAAAAAAAAAAAAA.tracks[5].uri === 'spotify:track:T000000000102');
    const addA = await d.req('add', { uri: 'spotify:playlist:CCCCCCCCCCCCCCCCCCCCCC', track: 'spotify:track:T000000000102' });
    const addX = await d.req('add', { uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', track: 'javascript:alert(1)' });
    check('…no en una lista de otra cuenta, ni algo que no sea una canción', addA && /no es de esta cuenta/.test(addA.error || '') && addX && addX.error && sp.lists.AAAAAAAAAAAAAAAAAAAAAA.tracks.length === 6, [addA && addA.error, addX && addX.error]);
    const ls = await d.req('lists');
    check('«Mis listas»: dice cuáles son de la cuenta (se ven por dentro) y cuántas canciones tienen', ls && ls.ok && ls.data.items.length === 3 && ls.data.items[0].own === true && ls.data.items[2].own === false && ls.data.items[1].total === 2, ls && ls.data);
    sp.player.shuffle = false; sp.player.repeat = 'off';

    // ── Pausa automática: «Adivina la canción» y vídeo con sonido ──
    spReset();
    d.emit('director:launch_round', { roundId: rCan.id });
    await until(() => !sp.player.is_playing);
    check('Con «Adivina la canción» Spotify se funde y se pausa solo', sp.player.is_playing === false && spCalls(/pause/).length === 1 && vols(sp.calls).includes(0));
    spReset();
    d.emit('director:launch_round', { roundId: rPul.id });
    await until(() => sp.player.is_playing && vols(sp.calls).slice(-1)[0] === 40, 6000);
    check('Al salir de esa prueba vuelve con fundido al volumen de antes', sp.player.is_playing && vols(sp.calls).slice(-1)[0] === 40, vols(sp.calls));
    await wait(1500); // termina la sintonía de pulsador que se lanzó al cambiar de ronda (y su vuelta)
    S.emit('screen:jingle_end', { id: (d.state.director.sound.jingle || {}).id }); await wait(2500);
    spReset();
    S.emit('screen:bg_hold', { on: true });
    await until(() => !sp.player.is_playing);
    check('Un vídeo con sonido en la pantalla también calla Spotify', sp.player.is_playing === false && spCalls(/pause/).length === 1);
    S.emit('screen:bg_hold', { on: false });
    await until(() => sp.player.is_playing, 5000);
    check('…y al acabar el vídeo vuelve', sp.player.is_playing === true);
    await wait(1500);

    // ── Volver a la música propia ──
    spReset();
    d.emit('director:sound', { action: 'source', value: 'own' });
    await until(() => !sp.player.is_playing);
    await wait(300);
    check('Elegir «Música propia» funde y pausa Spotify (una sola fuente a la vez)', d.state.director.sound.source === 'own' && sp.player.is_playing === false && vols(sp.calls).includes(0) && sp.player.volume === 40, vols(sp.calls));
    spReset();
    d.emit('director:sound', { action: 'sp_play' }); await wait(600);
    check('Con «Música propia» las órdenes de Spotify no hacen nada', !sp.calls.some(c => /\/me\/player\/play/.test(c.path)));
    d.emit('director:sound', { action: 'source', value: 'spotify' }); await wait(400);
    check('Elegir Spotify para la música propia de la pantalla', d.state.director.sound.source === 'spotify' && S.sync.sound.bg.playing === false);

    // ── Sin reproductor activo: se usa el Spotify abierto en el ordenador ──
    sp.active = false; await wait(4500);
    check('Sin reproductor activo el panel lo explica (no es un error)', d.state.spotify.player === null && d.state.spotify.error === null);
    spReset();
    d.emit('director:sound', { action: 'sp_play' });
    await until(() => sp.player.is_playing && sp.active);
    check('▶ con Spotify abierto pero parado: lo encuentra y lo pone a sonar ahí', spCalls(/GET \/v1\/me\/player\/devices/).length === 1 && spCalls(/play\?device_id=pc-sala/).length === 1 && sp.player.is_playing);
    sp.device = false; spReset();
    d.emit('director:sound', { action: 'sp_next' }); await until(() => d.state.spotify.error);
    check('Sin Spotify abierto en ningún sitio: aviso claro', d.state.spotify.error && d.state.spotify.error.code === 'nodevice' && /Abre Spotify/.test(d.state.spotify.error.text), d.state.spotify.error);
    sp.device = true; sp.active = true;

    // ── Sin Premium ──
    sp.premium = false;
    d.emit('director:sound', { action: 'sp_next' }); await until(() => d.state.spotify.error && d.state.spotify.error.code === 'premium');
    check('Cuenta sin Premium: aviso de que hace falta Premium', d.state.spotify.error && d.state.spotify.error.code === 'premium' && /Premium/.test(d.state.spotify.error.text));
    sp.premium = true;
    d.emit('director:sound', { action: 'sp_next' }); await until(() => d.state.spotify.error === null);
    check('Al arreglarse, el aviso desaparece', d.state.spotify.error === null);

    // ── Renovación y caducidad de la conexión ──
    const refreshesBefore = sp.calls.filter(c => c.params && c.params.grant_type === 'refresh_token').length;
    sp.expireNext = true; spReset();
    d.emit('director:sound', { action: 'sp_prev' }); await until(() => d.state.spotify.player && d.state.spotify.player.track === 'Canción anterior');
    check('La llave de una hora caduca: se renueva sola y la orden se cumple', sp.calls.some(c => c.params && c.params.grant_type === 'refresh_token' && c.params.client_id === CLIENT) && d.state.spotify.player.track === 'Canción anterior', refreshesBefore);
    sp.failRefresh = true; sp.expireNext = true;
    d.emit('director:sound', { action: 'sp_next' }); await until(() => d.state.spotify.error && d.state.spotify.error.code === 'expired');
    check('Conexión caducada (6 meses o permiso quitado): el panel avisa de reconectar', d.state.spotify.error && d.state.spotify.error.code === 'expired' && d.state.spotify.connected === false && d.state.spotify.expired === true, d.state.spotify);
    st = (await api('/spotify/status')).data;
    check('El backoffice la ve caducada', st.connected === false && st.expired === true);
    S.jingles = []; spReset();
    d.emit('director:sound', { action: 'jingle' }); await until(() => S.jingles.length);
    check('Sin conexión, las sintonías siguen sonando igual (sin esperar a Spotify)', S.jingles.length === 1 && S.jingles[0].cut === false && !sp.calls.length);
    sp.failRefresh = false;
    sp.narrowScope = true; // como una conexión hecha antes de pedir el permiso de cambiar listas
    await connectAccount();
    check('Volver a conectar lo arregla', (await api('/spotify/status')).data.connected === true);
    await until(() => d.state.spotify.connected);
    const old = await d.req('reorder', { uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', from: 0, to: 2 });
    check('Conexión sin el permiso de cambiar listas: el panel y el backoffice lo saben y piden volver a conectar', d.state.spotify.canEdit === false && (await api('/spotify/status')).data.canEdit === false && old && /volver a conectar/.test(old.error || ''), old && old.error);
    sp.narrowScope = false;
    check('Desconectar desde el backoffice', (await api('/spotify/disconnect', { method: 'POST' })).status === 200 && (await api('/spotify/status')).data.connected === false);

    // ── Los iPads no pueden mandar nada ──
    const before = d.state.director.sound.source;
    let ipadRes = 0; p.on('game:spotify_res', () => { ipadRes++; });
    p.emit('director:sound', { action: 'source', value: 'own' }); p.emit('director:spotify_lists'); p.emit('director:spotify_req', { id: 'x', op: 'lists' }); await wait(400);
    check('Un iPad no puede cambiar la fuente ni pedir las listas', d.state.director.sound.source === before && ipadRes === 0);

    d.close(); S.close(); p.close();
    await stopServer();

    // ── Kit offline: no existe ──
    await startServer({ GAMESHOW_KIT: '1' });
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    st = (await api('/spotify/status')).data;
    check('En el kit offline Spotify no aparece', st.enabled === false);
    check('…ni se puede conectar', (await api('/spotify/login')).status === 404 && (await api('/spotify/config', { method: 'PUT', body: { clientId: CLIENT } })).status === 404);
    const dk = director(g.id); await connected(dk); await wait(500);
    check('El coordinador del kit no ve Spotify y el juego empieza con la música propia', dk.state && dk.state.spotify.enabled === false && dk.state.director.sound.source === 'own', dk.state && dk.state.director.sound.source);
    dk.emit('director:sound', { action: 'source', value: 'spotify' }); await wait(400);
    check('…y no se puede elegir Spotify', dk.state.director.sound.source === 'own');
    dk.close();
    await stopServer();
    fakeSrv.close();

    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    process.exit(ok === results.length ? 0 : 1);
})().catch(async e => { console.error(e); try { await stopServer(); } catch {} process.exit(1); });
