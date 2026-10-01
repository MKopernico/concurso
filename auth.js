// Autenticación del equipo (backoffice + coordinador) y pases de juego para los iPads.
//
// - Contraseña general: hash scrypt en la tabla settings, cambiable desde el backoffice.
//   La variable de entorno ADMIN_PASSWORD funciona siempre como llave maestra (recuperación).
// - Sesión: cookie firmada con HMAC, renovable (12 h desde la última actividad).
//   Cambiar la contraseña sube la "época" y cierra el resto de sesiones.
// - Pase de juego: HMAC(gameId + código de acceso). Lo emite el servidor al validar el código
//   o vía QR; cambiar el código del juego invalida los pases anteriores.

const crypto = require('crypto');
const { db } = require('./db');

const COOKIE_NAME = 'gs_auth';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 60 * 1000; // re-emitir la cookie si tiene más de 1 h

// ───────────────── settings ─────────────────

function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

let _secret = null;
function secret() {
    if (_secret) return _secret;
    _secret = getSetting('auth_secret');
    if (!_secret) {
        _secret = crypto.randomBytes(32).toString('hex');
        setSetting('auth_secret', _secret);
    }
    return _secret;
}

function sign(data) {
    return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ───────────────── contraseña ─────────────────

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function checkHash(pw, stored) {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return safeEqual(test, hash);
}

function isConfigured() {
    return !!process.env.ADMIN_PASSWORD || !!getSetting('admin_password_hash');
}

function verifyPassword(pw) {
    if (!pw) return false;
    const master = process.env.ADMIN_PASSWORD;
    if (master && safeEqual(pw, master)) return true;
    const stored = getSetting('admin_password_hash');
    return !!stored && checkHash(pw, stored);
}

function epoch() {
    return Number(getSetting('session_epoch') || 0);
}

function setPassword(pw) {
    setSetting('admin_password_hash', hashPassword(pw));
    setSetting('session_epoch', String(epoch() + 1));
}

// ───────────────── sesión ─────────────────

function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({ iat: Date.now(), ep: epoch() })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function readSessionToken(token) {
    if (!token) return null;
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.ep !== epoch()) return null;
        if (Date.now() - data.iat > SESSION_MS) return null;
        return data;
    } catch { return null; }
}

function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

function sessionFromCookieHeader(header) {
    return readSessionToken(parseCookies(header)[COOKIE_NAME]);
}

function setSessionCookie(req, res) {
    res.cookie(COOKIE_NAME, createSessionToken(), {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/',
    });
}

function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Comprueba la sesión y la renueva si lleva más de 1 h (sesión deslizante).
function isStaffRequest(req, res) {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (!s) return false;
    if (res && Date.now() - s.iat > RENEW_AFTER_MS) setSessionCookie(req, res);
    return true;
}

function requireStaffPage(req, res, next) {
    if (isStaffRequest(req, res)) return next();
    res.redirect('/login/?next=' + encodeURIComponent(req.originalUrl));
}

// Rutas de la API abiertas a iPads y pantalla (todo lo demás exige sesión).
const PUBLIC_API = [
    ['GET',  /^\/active-games$/],
    ['GET',  /^\/games\/[^/]+\/public$/],
    ['POST', /^\/games\/[^/]+\/join$/],
    ['POST', /^\/upload\/image$/],           // foto del equipo desde el iPad
    ['POST', /^\/auth\/login$/],
    ['POST', /^\/auth\/logout$/],
    ['GET',  /^\/auth\/me$/],
];

function requireStaffApi(req, res, next) {
    if (PUBLIC_API.some(([m, re]) => m === req.method && re.test(req.path))) return next();
    if (isStaffRequest(req, res)) return next();
    res.status(401).json({ error: 'sesión requerida', auth: true });
}

// ───────────────── pase de juego (iPads) ─────────────────

function gamePass(gameId, accessCode) {
    return sign(`pass:${gameId}:${accessCode || ''}`).slice(0, 22);
}

function verifyGamePass(gameId, pass) {
    const game = db.prepare('SELECT access_code FROM games WHERE id = ?').get(gameId);
    if (!game) return false;
    if (!game.access_code) return true; // juego sin código: entrada libre
    return !!pass && safeEqual(pass, gamePass(gameId, game.access_code));
}

function gamePassFor(gameId) {
    const game = db.prepare('SELECT access_code FROM games WHERE id = ?').get(gameId);
    return game ? gamePass(gameId, game.access_code) : null;
}

// ───────────────── límite de intentos ─────────────────

function makeLimiter(max, windowMs) {
    const hits = new Map();
    return {
        blocked(key) {
            const h = hits.get(key);
            if (!h || Date.now() - h.start > windowMs) return false;
            return h.count >= max;
        },
        fail(key) {
            const h = hits.get(key);
            if (!h || Date.now() - h.start > windowMs) hits.set(key, { start: Date.now(), count: 1 });
            else h.count++;
        },
        reset(key) { hits.delete(key); },
    };
}

module.exports = {
    isConfigured, verifyPassword, setPassword,
    setSessionCookie, clearSessionCookie, isStaffRequest, sessionFromCookieHeader,
    requireStaffPage, requireStaffApi,
    gamePass, gamePassFor, verifyGamePass,
    makeLimiter,
};
