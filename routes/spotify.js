// Spotify (añadido opcional): el panel 🎵 del coordinador maneja el Spotify que ya suena en el
// ordenador de sala (Web API / Spotify Connect). Una sola cuenta (Premium, la de la empresa) se
// conecta una vez desde el backoffice y queda guardada en el servidor (settings 'spotify'):
//   GET  /spotify/status      → si está disponible, configurada y conectada (sin llaves)
//   PUT  /spotify/config      → { clientId } de la app de desarrollador (cambiarlo desconecta)
//   GET  /spotify/login       → manda a Spotify a dar permiso (PKCE: no hay secreto que guardar)
//   GET  /spotify/callback    → vuelta de Spotify: guarda la conexión y vuelve al backoffice
//   POST /spotify/disconnect  → olvida la conexión
//   GET  /spotify/playlists   → listas de la cuenta (para elegir la de cada juego)
// En directo (sockets/game.js) se usa `ctl`: estado de lo que suena (consultado cada pocos
// segundos solo mientras algún juego tiene Spotify como fuente), órdenes del panel y las
// «retenciones»: mientras haya alguna (sintonía, «Adivina la canción», karaoke, vídeo con sonido)
// Spotify se funde hasta callar y se pausa; al quitarse la última vuelve con fundido.
// En el kit offline no existe (sin internet y Spotify no admite direcciones http por IP).

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();

const ACCOUNTS = (process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com').replace(/\/$/, '');
const API = (process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1').replace(/\/$/, '');
// playlist-modify-*: reordenar y añadir canciones a las listas de la cuenta (versión ampliada del panel).
// Las conexiones hechas antes no lo tienen: `canEdit` lo dice y el panel pide volver a conectar.
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public';
const EDIT_SCOPE = 'playlist-modify-private';
const REFRESH_LIFE_MS = 183 * 24 * 3600 * 1000; // Spotify: la conexión dura 6 meses desde que se da permiso
const POLL_MS = 4000;
const FADE_OUT_MS = 1500, FADE_IN_MS = 1200, FADE_STEPS = 5;
const TIMEOUT_MS = 5000;

function enabled() { return process.env.GAMESHOW_KIT !== '1'; }

// ───────────────── configuración guardada (la conexión va cifrada) ─────────────────

function loadCfg() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'spotify'").get();
    if (!row) return {};
    try { return JSON.parse(row.value) || {}; } catch { return {}; }
}
function saveCfg(cfg) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('spotify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
}
function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', auth.subKey('spotify'), iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}
function unseal(s) {
    try {
        const [iv, tag, ct] = String(s).split('.').map(p => Buffer.from(p, 'base64url'));
        const d = crypto.createDecipheriv('aes-256-gcm', auth.subKey('spotify'), iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch { return null; }
}

// Enlace o URI de una lista/álbum de Spotify → «spotify:playlist:ID» (o null si no lo es)
function contextUri(s) {
    const m = String(s || '').trim().match(/^(?:spotify:|https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?)(playlist|album)[:/]([A-Za-z0-9]{10,40})/);
    return m ? `spotify:${m[1]}:${m[2]}` : null;
}

// ───────────────── llamadas a Spotify ─────────────────

const MESSAGES = {
    notConnected: 'Spotify no está conectado: se conecta en el backoffice (🎵 Spotify).',
    expired: 'La conexión con Spotify ha caducado: vuelve a conectarla en el backoffice (🎵 Spotify).',
    premium: 'Spotify pide una cuenta Premium para manejar la música.',
    forbidden: 'Spotify no deja usar esta cuenta con la app (tiene que ser Premium y estar en la lista de usuarios de la app).',
    nodevice: 'Abre Spotify en el ordenador de sala y pon algo un momento.',
    restricted: 'Ese reproductor de Spotify no deja que lo manejen desde fuera.',
    offline: 'No hay conexión con Spotify (¿hay internet?).',
    busy: 'Spotify va saturado: espera unos segundos.',
    notOwn: 'Spotify solo deja ver por dentro las listas creadas por esta cuenta (o colaborativas). Esta se puede poner a sonar entera.',
    scope: 'Para cambiar listas hay que volver a conectar Spotify una vez en el backoffice (🎵 Spotify › Conectar): pide un permiso nuevo.',
    notEditable: 'Esa lista no es de esta cuenta: Spotify no deja cambiarla.',
    changed: 'La lista ha cambiado mientras tanto: se ha vuelto a cargar.',
};
class SpError extends Error {
    constructor(code, status) { super(MESSAGES[code] || `Spotify ha dado un error (${status || code}).`); this.code = code; this.status = status; }
}

let _access = null; // { token, exp } solo en memoria

async function request(url, opts) {
    try {
        return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) { throw new SpError('offline'); }
}

async function tokenRequest(params) {
    const res = await request(ACCOUNTS + '/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data: data || {} };
}

async function accessToken() {
    if (_access && Date.now() < _access.exp - 30000) return _access.token;
    const cfg = loadCfg();
    const rt = cfg.rt && unseal(cfg.rt);
    if (!cfg.clientId || !rt) throw new SpError(cfg.expired ? 'expired' : 'notConnected');
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt, client_id: cfg.clientId });
    if (r.status === 400 || r.status === 401) {
        // invalid_grant: la conexión caducó (6 meses) o se quitó el permiso en la cuenta
        _access = null;
        saveCfg({ clientId: cfg.clientId, expired: true, user: cfg.user });
        throw new SpError('expired');
    }
    if (r.status !== 200 || !r.data.access_token) throw new SpError(r.status === 429 ? 'busy' : 'other', r.status);
    _access = { token: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
    if (r.data.refresh_token) saveCfg({ ...loadCfg(), rt: seal(r.data.refresh_token) }); // a veces da una nueva
    return _access.token;
}

async function api(method, path, body, retried) {
    const token = await accessToken();
    const res = await request(API + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { _access = null; return api(method, path, body, true); }
    let data = null;
    const txt = await res.text();
    if (txt) { try { data = JSON.parse(txt); } catch {} }
    if (res.status >= 200 && res.status < 300) return data;
    const reason = data && data.error && data.error.reason;
    if (reason === 'PREMIUM_REQUIRED') throw new SpError('premium', res.status);
    if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404) throw new SpError('nodevice', res.status);
    if (reason === 'VOLUME_CONTROL_DISALLOW' || reason === 'DEVICE_NOT_CONTROLLABLE') throw new SpError('restricted', res.status);
    if (res.status === 403) throw new SpError('forbidden', res.status);
    if (res.status === 429) throw new SpError('busy', res.status);
    throw new SpError('other', res.status);
}

// ───────────────── control en directo ─────────────────

const ctl = {
    player: null,        // lo que suena: { playing, track, artist, image, volume, supportsVolume, deviceId, deviceName, context }
    error: null,         // { code, text } de la última orden o consulta que falló
    at: 0,               // cuándo se consultó por última vez
    users: new Set(),    // juegos que tienen Spotify como fuente (solo entonces se consulta)
    holds: new Set(),    // retenciones activas («juego:motivo»)
    override: false,     // el coordinador le dio a ▶ con una retención puesta: se respeta hasta que se quiten todas
    pausedByUs: false,   // la pausa actual la puso GameShow (al quitar las retenciones, vuelve)
    resumeVol: null,     // volumen al que vuelve
    busy: null, again: false,
    listeners: new Set(),
    playlists: null,     // { at, items }
};
let _pollT = null;

function notify() { ctl.listeners.forEach(fn => { try { fn(); } catch (e) { console.error('[spotify]', e.message); } }); }
function onChange(fn) { ctl.listeners.add(fn); }
// Avisos: los de una orden (Premium, sin reproductor…) se quedan hasta que otra orden salga bien
// (o un minuto); las consultas periódicas solo ponen y quitan los suyos
const CMD_ERROR_MS = 60000;
function setError(e, fromPoll) {
    const cur = ctl.error;
    if (fromPoll && cur && cur.src === 'cmd' && Date.now() - cur.at < CMD_ERROR_MS) {
        // Spotify vuelve a tener reproductor: el aviso de abrirlo ya no hace falta
        if (!(cur.code === 'nodevice' && !e && ctl.player)) return false;
    }
    const next = e ? { code: e.code || 'other', text: e.message, src: fromPoll ? 'poll' : 'cmd', at: Date.now() } : null;
    if (!next && !cur) return false;
    if (next && cur && next.code === cur.code && next.src === cur.src) return false;
    ctl.error = next;
    return true;
}

const httpsUrl = (u) => typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
// Imágenes de Spotify (de la más grande a la más pequeña): la pequeña para listas, la mediana para la portada
function imageOf(imgs, big) {
    imgs = Array.isArray(imgs) ? imgs.filter(i => i && i.url) : [];
    if (!imgs.length) return null;
    return httpsUrl((big ? imgs[Math.min(1, imgs.length - 1)] : imgs[imgs.length - 1]).url);
}
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{10,40}$/;
// Una canción, como la ve el panel
function trackOf(it, albumImgs) {
    if (!it || !it.uri) return null;
    return {
        uri: String(it.uri),
        name: String(it.name || '—').slice(0, 160),
        artist: ((it.artists || []).map(a => a.name).join(', ') || (it.show && it.show.name) || '').slice(0, 160),
        ms: Number(it.duration_ms) || 0,
        image: imageOf((it.album && it.album.images) || it.images || albumImgs),
        playable: it.is_playable !== false && it.is_local !== true,
    };
}

function playerOf(d) {
    if (!d || !d.device) return null;
    const it = d.item || {};
    const imgs = (it.album && it.album.images) || it.images || [];
    return {
        playing: !!d.is_playing,
        track: it.name || null,
        artist: (it.artists || []).map(a => a.name).join(', ') || (it.show && it.show.name) || null,
        image: imageOf(imgs),
        imageBig: imageOf(imgs, true),
        trackUri: it.uri || null,
        progressMs: Number(d.progress_ms) || 0,
        durationMs: Number(it.duration_ms) || 0,
        shuffle: !!d.shuffle_state,
        repeat: d.repeat_state === 'track' || d.repeat_state === 'context' ? d.repeat_state : 'off',
        at: Date.now(), // cuándo se midió progressMs (el panel lo va contando él solo)
        volume: Number.isFinite(d.device.volume_percent) ? d.device.volume_percent : null,
        supportsVolume: d.device.supports_volume !== false && Number.isFinite(d.device.volume_percent),
        deviceId: d.device.id || null,
        deviceName: d.device.name || null,
        restricted: !!d.device.is_restricted,
        context: (d.context && d.context.uri) || null,
    };
}

// ¿Ha cambiado algo que el panel no pueda deducir solo? (el avance normal de la canción no cuenta:
// así no se avisa a los coordinadores cada 4 s mientras suena)
function playerKey(p) {
    if (!p) return 'null';
    const { progressMs, at, ...rest } = p;
    return JSON.stringify(rest);
}
function jumped(prev, p) {
    if (!prev || !p || prev.trackUri !== p.trackUri) return false;
    const expected = prev.progressMs + (prev.playing ? p.at - prev.at : 0);
    return Math.abs(p.progressMs - expected) > 2500;
}

async function refresh() {
    const prev = ctl.player, before = playerKey(prev) + JSON.stringify(ctl.error);
    try {
        ctl.player = playerOf(await api('GET', '/me/player'));
        setError(null, true);
    } catch (e) {
        ctl.player = null;
        setError(e.code === 'nodevice' ? null : e, true); // sin reproductor activo no es un error: el panel lo explica
    }
    ctl.at = Date.now();
    if (playerKey(ctl.player) + JSON.stringify(ctl.error) !== before || jumped(prev, ctl.player)) notify();
    else if (prev && ctl.player) { ctl.player.progressMs = prev.progressMs; ctl.player.at = prev.at; } // misma referencia de tiempo que ya tiene el panel
    return ctl.player;
}

function poll() {
    if (!ctl.users.size || !isConnected()) return stopPoll();
    if (ctl.busy) return;
    refresh().catch(() => {});
}
function stopPoll() { if (_pollT) { clearInterval(_pollT); _pollT = null; } }

// Un juego empieza o deja de usar Spotify como fuente
function setUser(gameId, on) {
    const had = ctl.users.has(gameId);
    if (on) ctl.users.add(gameId); else ctl.users.delete(gameId);
    if (on && !had && isConnected()) {
        refresh().catch(() => {});
        if (!_pollT) { _pollT = setInterval(poll, POLL_MS); _pollT.unref(); }
    }
}

function isConnected() {
    if (!enabled()) return false;
    const cfg = loadCfg();
    return !!(cfg.clientId && cfg.rt);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function setVolume(v) { await api('PUT', '/me/player/volume?volume_percent=' + Math.max(0, Math.min(100, Math.round(v)))); }
async function fade(from, to, ms) {
    for (let i = 1; i <= FADE_STEPS; i++) {
        const t0 = Date.now();
        await setVolume(from + (to - from) * i / FADE_STEPS);
        if (i < FADE_STEPS) await sleep(Math.max(0, ms / FADE_STEPS - (Date.now() - t0)));
    }
    if (ctl.player) ctl.player.volume = to;
}

// Lleva Spotify a lo que piden las retenciones (una transición cada vez; si cambian a mitad, se repite)
function reconcile() {
    if (ctl.busy) { ctl.again = true; return ctl.busy; }
    ctl.busy = (async () => {
        try {
            do { ctl.again = false; await reconcileStep(); } while (ctl.again);
        } finally { ctl.busy = null; notify(); }
    })();
    return ctl.busy;
}

async function reconcileStep() {
    const wantSilent = ctl.holds.size > 0 && !ctl.override;
    try {
        if (wantSilent && !ctl.pausedByUs) {
            const p = (Date.now() - ctl.at < 1500 && ctl.player) ? ctl.player : await refresh();
            if (!p || !p.playing) return; // no sonaba: nada que callar
            const vol = p.volume;
            const fadeable = p.supportsVolume && vol !== null && vol > 0;
            ctl.pausedByUs = true;
            ctl.resumeVol = vol;
            if (fadeable) await fade(vol, 0, FADE_OUT_MS);
            await api('PUT', '/me/player/pause');
            p.playing = false;
            if (fadeable) { await setVolume(vol); p.volume = vol; } // en pausa ya no se oye: si algo falla luego, no se queda a cero
            notify();
        } else if (!wantSilent && ctl.pausedByUs) {
            ctl.pausedByUs = false;
            const p = ctl.player, vol = ctl.resumeVol;
            const fadeable = p && p.supportsVolume && vol !== null && vol > 0;
            if (fadeable) await setVolume(0);
            await api('PUT', '/me/player/play');
            if (p) p.playing = true;
            notify();
            if (fadeable) await fade(0, vol, FADE_IN_MS);
        }
        setError(null);
    } catch (e) {
        setError(e);
        if (ctl.resumeVol !== null) setVolume(ctl.resumeVol).catch(() => {});
    }
}

function hold(key) {
    if (ctl.holds.has(key)) return ctl.busy || Promise.resolve();
    ctl.holds.add(key);
    return reconcile();
}
function release(key) {
    if (!ctl.holds.delete(key)) return;
    if (!ctl.holds.size) ctl.override = false;
    reconcile();
}
function releaseAll(prefix) {
    let changed = false;
    for (const k of [...ctl.holds]) if (k.startsWith(prefix)) { ctl.holds.delete(k); changed = true; }
    if (!changed) return;
    if (!ctl.holds.size) ctl.override = false;
    reconcile();
}
function isPlaying() { return !!(ctl.player && ctl.player.playing) || ctl.pausedByUs; }

// Antes de una sintonía: si Spotify suena, se funde y se pausa. Espera como mucho 2 s.
async function duck(key) {
    if (!isConnected()) return false;
    if (!ctl.pausedByUs) {
        if (Date.now() - ctl.at > 1500) await Promise.race([refresh(), sleep(1500)]).catch(() => {});
        if (!(ctl.player && ctl.player.playing)) return false;
    }
    await Promise.race([hold(key), sleep(2000)]);
    return true;
}

// Si no hay reproductor activo pero Spotify está abierto en algún sitio, se usa ese
async function pickDevice() {
    const d = await api('GET', '/me/player/devices');
    const list = ((d && d.devices) || []).filter(x => !x.is_restricted && x.id);
    const pc = list.find(x => x.type === 'Computer') || list[0];
    if (!pc) throw new SpError('nodevice');
    return pc.id;
}

// Poner a sonar (sin body: seguir donde iba). Sin reproductor activo, en el Spotify que esté abierto.
async function playBody(body) {
    try { await api('PUT', '/me/player/play', body); }
    catch (e) {
        if (e.code !== 'nodevice') throw e;
        await api('PUT', '/me/player/play?device_id=' + encodeURIComponent(await pickDevice()), body);
    }
}
// ▶ del coordinador con una retención puesta (sintonía, vídeo…): manda él hasta que se quiten todas
async function overrideHold() {
    if (!ctl.pausedByUs) return false;
    ctl.override = true;
    await reconcile();
    return true;
}

// Órdenes del panel 🎵
async function command(action, arg) {
    try {
        switch (action) {
            case 'play': case 'playlist': {
                const uri = action === 'playlist' ? contextUri(arg) : null;
                if (action === 'playlist' && !uri) return;
                if (await overrideHold() && !uri) break;
                await playBody(uri ? { context_uri: uri } : undefined);
                break;
            }
            case 'track': {
                // Una canción: dentro de su lista o álbum (sigue con las siguientes) o sola
                const uri = arg && TRACK_URI.test(arg.uri) ? arg.uri : null;
                if (!uri) return;
                const ctx = arg.context ? contextUri(arg.context) : null;
                await overrideHold();
                await playBody(ctx ? { context_uri: ctx, offset: { uri } } : { uris: [uri] });
                break;
            }
            case 'now': case 'queue': {
                // «▶ Ya»: a la cola y salta a ella, así luego sigue la lista que sonaba
                if (!TRACK_URI.test(arg || '')) return;
                await api('POST', '/me/player/queue?uri=' + encodeURIComponent(arg));
                if (action === 'now') {
                    await overrideHold();
                    await api('POST', '/me/player/next');
                }
                break;
            }
            case 'seek': {
                const ms = Math.round(Number(arg));
                if (!Number.isFinite(ms) || ms < 0) return;
                await api('PUT', '/me/player/seek?position_ms=' + ms);
                break;
            }
            case 'shuffle':
                await api('PUT', '/me/player/shuffle?state=' + (arg ? 'true' : 'false'));
                break;
            case 'repeat': {
                if (!['off', 'context', 'track'].includes(arg)) return;
                await api('PUT', '/me/player/repeat?state=' + arg);
                break;
            }
            case 'pause':
                ctl.pausedByUs = false; // la ha pausado el coordinador: no vuelve sola
                await api('PUT', '/me/player/pause');
                break;
            case 'stop': {
                // Cambio a la música propia o «Silencio total»: se funde y se queda en pausa
                if (!isConnected()) return;
                ctl.pausedByUs = false; ctl.override = false;
                const p = (Date.now() - ctl.at < 1500 && ctl.player) ? ctl.player : await refresh();
                if (!p || !p.playing) break;
                const vol = p.volume;
                const fadeable = p.supportsVolume && vol !== null && vol > 0;
                if (fadeable) await fade(vol, 0, FADE_OUT_MS);
                await api('PUT', '/me/player/pause');
                if (fadeable) await setVolume(vol);
                break;
            }
            case 'next': await api('POST', '/me/player/next'); break;
            case 'prev': await api('POST', '/me/player/previous'); break;
            case 'volume': {
                const v = Number(arg);
                if (!Number.isFinite(v)) return;
                if (ctl.pausedByUs) { ctl.resumeVol = Math.round(v); break; } // se aplicará al volver
                await setVolume(v);
                if (ctl.player) ctl.player.volume = Math.round(v);
                break;
            }
            default: return;
        }
        setError(null);
    } catch (e) { setError(e); }
    await sleep(350); // Spotify tarda un poco en reflejar la orden
    await refresh().catch(() => {});
    notify();
}

// Id de la cuenta conectada (para saber qué listas son suyas). Las conexiones antiguas no lo guardaron.
async function userId() {
    const cfg = loadCfg();
    if (cfg.userId) return cfg.userId;
    const me = await api('GET', '/me');
    const id = me && me.id ? String(me.id) : null;
    if (id) saveCfg({ ...loadCfg(), userId: id });
    return id;
}
function canEdit() { return String(loadCfg().scope || '').split(' ').includes(EDIT_SCOPE); }
const idOf = (uri, kind) => { const m = String(uri || '').match(new RegExp('^spotify:' + kind + ':([A-Za-z0-9]{10,40})$')); return m ? m[1] : null; };

async function playlists(fresh) {
    if (!fresh && ctl.playlists && Date.now() - ctl.playlists.at < 60000) return ctl.playlists.items;
    const [d, me] = await Promise.all([api('GET', '/me/playlists?limit=50'), userId().catch(() => null)]);
    const items = ((d && d.items) || []).filter(p => p && p.uri).map(p => ({
        uri: p.uri, name: String(p.name || 'Lista').slice(0, 120),
        image: imageOf(p.images),
        owner: String((p.owner && (p.owner.display_name || p.owner.id)) || '').slice(0, 80),
        // Solo de estas se ven las canciones (y se pueden cambiar)
        own: !!(p.collaborative || (me && p.owner && p.owner.id === me)),
        total: Number((p.items && p.items.total) ?? (p.tracks && p.tracks.total)) || 0,
    }));
    ctl.playlists = { at: Date.now(), items };
    return items;
}

// Canciones de una lista (solo propias o colaborativas: Spotify, desde 2026) o de un álbum, de 50 en 50
async function listItems(uri, offset) {
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    const albumId = idOf(uri, 'album');
    if (albumId) {
        const a = await api('GET', `/albums/${albumId}`);
        const t = await api('GET', `/albums/${albumId}/tracks?limit=50&offset=${offset}`);
        return {
            uri, kind: 'album', name: String((a && a.name) || 'Álbum').slice(0, 120), owner: ((a && a.artists) || []).map(x => x.name).join(', ').slice(0, 120),
            image: imageOf(a && a.images, true), editable: false, snapshot: null, offset, total: Number(t && t.total) || 0,
            items: ((t && t.items) || []).map(x => trackOf(x, a && a.images)).filter(Boolean),
        };
    }
    const id = idOf(uri, 'playlist');
    if (!id) throw new SpError('other', 400);
    let p, t;
    try {
        [p, t] = await Promise.all([
            api('GET', `/playlists/${id}?fields=name,owner(id,display_name),collaborative,snapshot_id,images`),
            api('GET', `/playlists/${id}/items?limit=50&offset=${offset}`),
        ]);
    } catch (e) { throw e.code === 'forbidden' || e.code === 'nodevice' ? new SpError('notOwn', e.status) : e; }
    const me = await userId().catch(() => null);
    return {
        uri, kind: 'playlist', name: String((p && p.name) || 'Lista').slice(0, 120),
        owner: String((p && p.owner && (p.owner.display_name || p.owner.id)) || '').slice(0, 80),
        image: imageOf(p && p.images, true),
        editable: !!(p && (p.collaborative || (me && p.owner && p.owner.id === me))),
        snapshot: (t && t.snapshot_id) || (p && p.snapshot_id) || null,
        offset, total: Number(t && t.total) || 0,
        // Spotify 2026: cada fila trae la canción en `item` (antes en `track`)
        items: ((t && t.items) || []).map(x => trackOf(x && (x.item || x.track))).filter(Boolean),
    };
}

// Lo que suena y lo que viene (Spotify no deja quitar ni reordenar la cola: solo añadir)
async function queue() {
    const d = await api('GET', '/me/player/queue');
    return {
        current: trackOf(d && d.currently_playing),
        items: ((d && d.queue) || []).slice(0, 30).map(x => trackOf(x)).filter(Boolean),
    };
}

// Buscar canciones (Spotify da como mucho 10 por petición en modo desarrollo)
async function search(q, offset) {
    q = String(q || '').trim().slice(0, 100);
    if (!q) return { q, offset: 0, total: 0, items: [] };
    offset = Math.max(0, Math.min(990, Math.floor(Number(offset) || 0)));
    const d = await api('GET', `/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(q)}`);
    const t = (d && d.tracks) || {};
    return { q, offset, total: Number(t.total) || 0, items: (t.items || []).map(x => trackOf(x)).filter(Boolean) };
}

async function editablePlaylist(uri) {
    if (!canEdit()) throw new SpError('scope');
    const id = idOf(uri, 'playlist');
    if (!id) throw new SpError('notEditable');
    return id;
}
// Mover una canción dentro de una lista propia (from → antes de la posición `to`, como pide Spotify)
async function reorder(uri, from, to, snapshot) {
    const id = await editablePlaylist(uri);
    from = Math.floor(Number(from)); to = Math.floor(Number(to));
    if (!(from >= 0) || !(to >= 0) || from === to || from + 1 === to) return null;
    const body = { range_start: from, insert_before: to, range_length: 1 };
    if (typeof snapshot === 'string' && snapshot) body.snapshot_id = snapshot;
    let d;
    try { d = await api('PUT', `/playlists/${id}/items`, body); }
    catch (e) { throw e.code === 'forbidden' ? new SpError('notEditable', e.status) : e; }
    return (d && d.snapshot_id) || null;
}
async function addToList(uri, trackUri) {
    const id = await editablePlaylist(uri);
    if (!TRACK_URI.test(trackUri || '')) throw new SpError('other', 400);
    let d;
    try { d = await api('POST', `/playlists/${id}/items`, { uris: [trackUri] }); }
    catch (e) { throw e.code === 'forbidden' ? new SpError('notEditable', e.status) : e; }
    if (ctl.playlists) ctl.playlists.at = 0; // el número de canciones ha cambiado
    return (d && d.snapshot_id) || null;
}

// Lo que ve el coordinador (nunca llaves)
function view() {
    if (!enabled()) return { enabled: false };
    const cfg = loadCfg();
    return {
        enabled: true,
        connected: !!(cfg.clientId && cfg.rt),
        expired: !!cfg.expired,
        user: cfg.user || null,
        canEdit: String(cfg.scope || '').split(' ').includes(EDIT_SCOPE),
        player: ctl.player,
        now: Date.now(), // reloj del servidor, para contar el avance de la canción
        held: ctl.pausedByUs,
        error: ctl.error && { code: ctl.error.code, text: ctl.error.text },
    };
}

// ───────────────── rutas del backoffice ─────────────────

const pending = new Map(); // state → { verifier, redirectUri, at }

function redirectUriOf(req) { return `${req.protocol}://${req.get('host')}/api/spotify/callback`; }
function hostWarning(req) {
    const host = String(req.get('host') || '');
    if (/^localhost(:|$)/i.test(host)) return 'Spotify no admite «localhost»: abre el backoffice con http://127.0.0.1' + host.slice(9) + ' para conectar.';
    if (req.protocol !== 'https' && !/^(127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return 'Spotify solo admite direcciones https (o 127.0.0.1 en el propio ordenador).';
    return null;
}

router.use('/spotify', (req, res, next) => {
    if (!enabled() && req.path !== '/status') return res.status(404).json({ error: 'Spotify no está disponible en el kit offline' });
    next();
});

router.get('/spotify/status', (req, res) => {
    if (!enabled()) return res.json({ enabled: false });
    const cfg = loadCfg();
    res.json({
        enabled: true,
        clientId: cfg.clientId || '',
        connected: !!(cfg.clientId && cfg.rt),
        expired: !!cfg.expired,
        user: cfg.user || null,
        canEdit: String(cfg.scope || '').split(' ').includes(EDIT_SCOPE),
        connectedAt: cfg.connectedAt || null,
        expiresAt: cfg.connectedAt ? cfg.connectedAt + REFRESH_LIFE_MS : null,
        redirectUri: redirectUriOf(req),
        warning: hostWarning(req),
    });
});

router.put('/spotify/config', (req, res) => {
    const id = String((req.body && req.body.clientId) || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) return res.status(400).json({ error: 'El Client ID son 32 letras y números (cópialo del panel de Spotify).' });
    const cfg = loadCfg();
    if (cfg.clientId !== id) { saveCfg({ clientId: id }); _access = null; ctl.playlists = null; }
    res.json({ ok: true });
});

router.get('/spotify/login', (req, res) => {
    const cfg = loadCfg();
    if (!cfg.clientId) return res.redirect('/admin/?spotify=' + encodeURIComponent('Primero guarda el Client ID.'));
    const warn = hostWarning(req);
    if (warn) return res.redirect('/admin/?spotify=' + encodeURIComponent(warn));
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > 10 * 60000) pending.delete(k);
    if (pending.size > 20) pending.delete(pending.keys().next().value);
    pending.set(state, { verifier, redirectUri: redirectUriOf(req), at: now });
    const q = new URLSearchParams({
        response_type: 'code', client_id: cfg.clientId, scope: SCOPES, redirect_uri: redirectUriOf(req), state,
        code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
    res.redirect(ACCOUNTS + '/authorize?' + q.toString());
});

router.get('/spotify/callback', async (req, res) => {
    const back = (msg) => res.redirect('/admin/?spotify=' + encodeURIComponent(msg));
    const p = pending.get(String(req.query.state || ''));
    if (!p) return back('El permiso ha caducado o no viene de aquí: vuelve a pulsar «Conectar».');
    pending.delete(String(req.query.state));
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'No se dio permiso en Spotify.' : 'Spotify no dio permiso (' + String(req.query.error).slice(0, 60) + ').');
    const cfg = loadCfg();
    try {
        const r = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: p.redirectUri, client_id: cfg.clientId, code_verifier: p.verifier });
        if (r.status !== 200 || !r.data.refresh_token) return back('Spotify no aceptó la conexión (' + String((r.data && (r.data.error_description || r.data.error)) || r.status).slice(0, 80) + ').');
        _access = { token: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
        // scope: los permisos que dio de verdad (sin los de cambiar listas, el panel no lo ofrece)
        saveCfg({ clientId: cfg.clientId, rt: seal(r.data.refresh_token), connectedAt: Date.now(), scope: String(r.data.scope || '').slice(0, 500) });
        let user = null, uid = null;
        try {
            const me = await api('GET', '/me');
            user = me && (me.display_name || me.id) ? String(me.display_name || me.id).slice(0, 80) : null;
            uid = me && me.id ? String(me.id) : null;
        } catch {}
        saveCfg({ ...loadCfg(), user, userId: uid });
        ctl.playlists = null;
        setError(null);
        for (const g of [...ctl.users]) { ctl.users.delete(g); setUser(g, true); }
        notify();
        back('ok');
    } catch (e) { back(e.message); }
});

router.post('/spotify/disconnect', (req, res) => {
    const cfg = loadCfg();
    saveCfg({ clientId: cfg.clientId || undefined });
    _access = null; ctl.player = null; ctl.playlists = null; ctl.pausedByUs = false;
    stopPoll();
    notify();
    res.json({ ok: true });
});

router.get('/spotify/playlists', async (req, res) => {
    try { res.json({ items: await playlists() }); }
    catch (e) { res.status(e.code === 'notConnected' || e.code === 'expired' ? 409 : 502).json({ error: e.message, code: e.code }); }
});

module.exports = {
    router, enabled, contextUri, view, isConnected, setUser, onChange,
    hold, release, releaseAll, duck, isPlaying, command, playlists,
    listItems, queue, search, reorder, addToList, canEdit,
    _ctl: ctl,
};
