// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-spotify.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos) y un «Spotify de
// mentira» (cuentas + Web API) en otro puerto. Comprueba: preparar y conectar la cuenta (PKCE,
// permisos, vuelta al backoffice, conexión cifrada), lo que ve el coordinador, elegir fuente,
// órdenes del panel, sintonía con Spotify (fundido hasta callar → sintonía entera → vuelve con
// fundido), pausa automática con «Adivina la canción» y vídeo, sin reproductor activo, sin
// Premium, renovación y caducidad de la conexión, iPads sin acceso y el kit offline (no aparece).
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
    player: { is_playing: true, volume: 60, track: 'Canción de prueba', context: null },
};
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
                return send(200, { access_token: at, refresh_token: rt, expires_in: 3600 });
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
        if (p === '/me/playlists') return send(200, { items: [{ uri: 'spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA', name: 'Fiesta', images: [] }] });
        if (p === '/me/player/devices') return send(200, { devices: sp.device ? [{ id: 'pc-sala', name: 'PC-SALA', type: 'Computer', is_restricted: false, volume_percent: sp.player.volume }] : [] });
        if (!sp.premium && req.method !== 'GET') return send(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
        const devId = url.searchParams.get('device_id');
        if (devId === 'pc-sala') sp.active = true;
        if (p === '/me/player' && req.method === 'GET') {
            if (!sp.device || !sp.active) return send(204);
            return send(200, { is_playing: sp.player.is_playing, device: { id: 'pc-sala', name: 'PC-SALA', type: 'Computer', is_restricted: false, supports_volume: true, volume_percent: sp.player.volume },
                item: { name: sp.player.track, artists: [{ name: 'Artista' }], album: { images: [{ url: 'https://i.scdn.co/image/grande' }, { url: 'https://i.scdn.co/image/peque' }] } }, context: sp.player.context ? { uri: sp.player.context } : null });
        }
        if (!sp.device || !sp.active) return send(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
        if (p === '/me/player/volume') { sp.player.volume = Number(url.searchParams.get('volume_percent')); return send(204); }
        if (p === '/me/player/pause') { sp.player.is_playing = false; return send(204); }
        if (p === '/me/player/play') {
            sp.player.is_playing = true;
            try { const b = JSON.parse(body || '{}'); if (b.context_uri) sp.player.context = b.context_uri; } catch {}
            return send(204);
        }
        if (p === '/me/player/next') { sp.player.track = 'Siguiente canción'; return send(204); }
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
    sp.codes.set(code, { challenge: loc.searchParams.get('code_challenge'), redirect: loc.searchParams.get('redirect_uri') });
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
    check('«Conectar» manda a Spotify con PKCE y solo los permisos necesarios', login.status === 302 && loc.origin === `http://127.0.0.1:${FAKE}` && loc.pathname === '/authorize' &&
        loc.searchParams.get('client_id') === CLIENT && loc.searchParams.get('code_challenge_method') === 'S256' && loc.searchParams.get('redirect_uri') === `${B}/api/spotify/callback` &&
        scopes.length === 5 && ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing', 'playlist-read-private', 'playlist-read-collaborative'].every(x => scopes.includes(x)), loc.search);
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
    await connected(d); await wait(500);
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
    await connectAccount();
    check('Volver a conectar lo arregla', (await api('/spotify/status')).data.connected === true);
    check('Desconectar desde el backoffice', (await api('/spotify/disconnect', { method: 'POST' })).status === 200 && (await api('/spotify/status')).data.connected === false);

    // ── Los iPads no pueden mandar nada ──
    const before = d.state.director.sound.source;
    p.emit('director:sound', { action: 'source', value: 'own' }); p.emit('director:spotify_lists'); await wait(400);
    check('Un iPad no puede cambiar la fuente ni pedir las listas', d.state.director.sound.source === before);

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
