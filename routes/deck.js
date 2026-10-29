// Stream Deck (complemento «GameShow» para el programa de Elgato): el complemento se conecta al
// servidor como un coordinador más, con una clave propia en vez de la sesión del navegador.
//   GET    /deck/keys        → claves creadas (sin la clave en sí), si están conectadas y con qué juego
//   POST   /deck/keys        → { name } crea una clave nueva: se enseña UNA vez para pegarla en el complemento
//   DELETE /deck/keys/:id    → la anula (los Stream Deck que la usan se desconectan)
// Emparejar: el coordinador pulsa «🎛 Usar Stream Deck aquí» (director:deck_pair) y desde ese momento
// ese Stream Deck maneja ese juego. El emparejamiento se guarda: sobrevive a reinicios del servidor.
// Las claves se guardan como HMAC (con auth.subKey('deck')): ni la base de datos las tiene en claro.

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();
const MAX_KEYS = 20;

function load() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'deck'").get();
    let v = null;
    try { v = row && JSON.parse(row.value); } catch {}
    return v && Array.isArray(v.keys) ? v : { keys: [] };
}
function save(v) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('deck', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(v));
}
const hashOf = (plain) => crypto.createHmac('sha256', auth.subKey('deck')).update(String(plain)).digest('base64url');

// Clave del complemento → su entrada (o null). Se compara el HMAC en tiempo constante.
function verify(plain) {
    if (typeof plain !== 'string' || !/^gsd_[A-Za-z0-9_-]{20,80}$/.test(plain)) return null;
    const h = Buffer.from(hashOf(plain));
    for (const k of load().keys) {
        const kh = Buffer.from(k.hash);
        if (kh.length === h.length && crypto.timingSafeEqual(kh, h)) return k;
    }
    return null;
}
function byId(id) { return load().keys.find(k => k.id === id) || null; }
function update(id, fields) {
    const v = load();
    const k = v.keys.find(x => x.id === id);
    if (!k) return null;
    Object.assign(k, fields);
    save(v);
    return k;
}

// ── En directo: qué Stream Deck están conectados ahora (sockets de control) ──
const online = new Map(); // keyId → Set(socket)
const listeners = new Set();
function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error('[deck]', e.message); } }); }
function onChange(fn) { listeners.add(fn); }
function attach(keyId, socket) {
    if (!online.has(keyId)) online.set(keyId, new Set());
    online.get(keyId).add(socket);
    update(keyId, { lastSeen: Date.now() });
    notify();
}
function detach(keyId, socket) {
    const s = online.get(keyId);
    if (!s) return;
    s.delete(socket);
    if (!s.size) online.delete(keyId);
    notify();
}
function isOnline(keyId) { return online.has(keyId); }
// A los complementos con esa clave: con qué juego van (o que la clave ya no vale)
function statusOf(k, gameName) {
    return k ? { ok: true, name: k.name, gameId: k.gameId || null, gameName: gameName || null } : { ok: false };
}
function tell(keyId, payload) {
    const s = online.get(keyId);
    if (s) s.forEach(sock => sock.emit('deck:status', payload));
}
// Conexiones de juego de cada clave (las que reciben el estado con las respuestas): al anularla o
// emparejarla con otro juego se cortan, no basta con dejar de aceptar sus órdenes
const gameSockets = new Map(); // keyId → Set(socket)
function attachGame(keyId, socket) {
    if (!gameSockets.has(keyId)) gameSockets.set(keyId, new Set());
    gameSockets.get(keyId).add(socket);
    socket.on('disconnect', () => { const s = gameSockets.get(keyId); if (s) { s.delete(socket); if (!s.size) gameSockets.delete(keyId); } });
}
function cutGames(keyId, keepGameId) {
    const s = gameSockets.get(keyId);
    if (s) [...s].forEach(sock => { if (!keepGameId || sock.gameId !== keepGameId) sock.disconnect(true); });
}
function pair(keyId, gameId, gameName) {
    const k = update(keyId, { gameId });
    if (!k) return null;
    cutGames(keyId, gameId);
    tell(keyId, statusOf(k, gameName));
    notify();
    return k;
}
// Lo que ve el coordinador al abrir «🎛 Stream Deck»
function list(gameNames) {
    return load().keys.map(k => ({ id: k.id, name: k.name, online: isOnline(k.id), gameId: k.gameId || null,
        gameName: k.gameId ? (gameNames && gameNames(k.gameId)) || null : null, lastSeen: k.lastSeen || null }));
}

// ── Backoffice ──
router.get('/deck/keys', (req, res) => {
    const name = (id) => { const g = db.prepare('SELECT name FROM games WHERE id = ?').get(id); return g ? g.name : null; };
    res.json({ items: list(name) });
});
router.post('/deck/keys', (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60) || 'Stream Deck';
    const v = load();
    if (v.keys.length >= MAX_KEYS) return res.status(400).json({ error: 'Ya hay ' + MAX_KEYS + ' claves: anula alguna que no se use.' });
    const plain = 'gsd_' + crypto.randomBytes(24).toString('base64url');
    const id = 'k' + crypto.randomBytes(5).toString('hex');
    v.keys.push({ id, name, hash: hashOf(plain), createdAt: Date.now(), lastSeen: null, gameId: null });
    save(v);
    res.json({ id, name, key: plain });
});
router.delete('/deck/keys/:id', (req, res) => {
    const v = load();
    const i = v.keys.findIndex(k => k.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'No existe' });
    const [k] = v.keys.splice(i, 1);
    save(v);
    // Los complementos conectados con ella se enteran y se cortan
    const s = online.get(k.id);
    if (s) s.forEach(sock => { sock.emit('deck:status', { ok: false }); sock.disconnect(true); });
    online.delete(k.id);
    revoked.add(k.id);
    cutGames(k.id, null);
    notify();
    res.json({ ok: true });
});
// Claves anuladas en esta ejecución: los sockets de juego que la usaban dejan de mandar órdenes
const revoked = new Set();
function stillValid(keyId) { return !revoked.has(keyId) && !!byId(keyId); }

module.exports = { router, verify, byId, attach, detach, attachGame, isOnline, pair, list, statusOf, stillValid, onChange };
