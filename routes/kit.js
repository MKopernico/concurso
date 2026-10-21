// Kit offline descargable desde el backoffice (⬇ Descargas → Kit offline).
//
// El zip se monta con kit/assemble.js y se guarda en <datos>/kit-cache (en Render, el disco persistente).
// - En Render se prepara solo al arrancar, en segundo plano (1-2 min): al desplegar, el kit queda al día.
// - En local se prepara la primera vez que se pide.
// - Si no ha cambiado nada de lo que entra en el kit, se reutiliza el zip anterior.
// - node.exe y better-sqlite3 para Windows se descargan una vez y quedan guardados.
// - Dentro del propio kit no se ofrece (no lleva las herramientas para montarlo).

const path = require('path');
const fs = require('fs');
const express = require('express');
const { DB_DIR } = require('../paths');

const router = express.Router();
const CACHE_DIR = path.join(DB_DIR, 'kit-cache');
const MIN_FREE_MB = 300; // los juegos tienen prioridad sobre el kit en el disco
// Dentro del kit (o de su app empaquetada, que no lleva esbuild) no se pueden montar kits
const IN_KIT = process.env.GAMESHOW_KIT === '1' || (() => { try { require.resolve('esbuild/package.json'); return false; } catch (e) { return true; } })();

const kit = { status: IN_KIT ? 'unavailable' : 'idle', error: '', file: '', size: 0, version: '', builtAt: 0 };
let job = null;
let fingerprint = null;

function freeMb(dir) {
    try { const s = fs.statfsSync(dir); return Math.floor(s.bavail * s.bsize / 1048576); }
    catch (e) { return Infinity; }
}

function readVersion(zipBase) {
    try { return fs.readFileSync(zipBase + '.version', 'utf8').trim(); } catch (e) { return ''; }
}

function ensureKit() {
    if (IN_KIT) return Promise.resolve();
    if (job) return job;
    job = (async () => {
        const assemble = require('../kit/assemble');
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        if (!fingerprint) fingerprint = assemble.kitFingerprint();
        const file = path.join(CACHE_DIR, `kit-${fingerprint}.zip`);
        if (!fs.existsSync(file)) {
            kit.status = 'building';
            kit.error = '';
            const free = freeMb(CACHE_DIR);
            if (free < MIN_FREE_MB) throw new Error(`Queda poco espacio en el disco del servidor (${free} MB libres; hacen falta ${MIN_FREE_MB}). Borra juegos o archivos que no uses.`);
            const t0 = Date.now();
            const entries = await assemble.kitEntries({ cacheDir: CACHE_DIR, log: (s) => console.log('[kit] ' + s) });
            const version = entries.find(e => e.name === 'VERSION.txt').data.toString('utf8');
            await assemble.writeZip(entries, file);
            fs.writeFileSync(file + '.version', version);
            console.log(`[kit] listo en ${((Date.now() - t0) / 1000).toFixed(0)} s · ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
        }
        // Solo se conserva el kit actual (los binarios descargados se quedan para la próxima vez)
        for (const f of fs.readdirSync(CACHE_DIR)) {
            if (/^kit-.*\.zip(\.part|\.version)?$/.test(f) && !f.startsWith(path.basename(file))) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
        }
        const stat = fs.statSync(file);
        Object.assign(kit, { status: 'ready', error: '', file, size: stat.size, builtAt: stat.mtimeMs, version: readVersion(file) });
    })().catch(err => {
        console.error('[kit] ' + err.message);
        Object.assign(kit, { status: 'error', error: err.message });
    }).finally(() => { job = null; });
    return job;
}

function publicStatus() {
    const v = /Versión del código: (.*)/.exec(kit.version);
    return {
        status: kit.status,
        error: kit.status === 'unavailable' ? 'Estás en el kit offline: descarga el kit desde la versión online.' : kit.error,
        sizeMb: kit.size ? Math.round(kit.size / 1048576) : 0,
        version: v ? v[1].trim() : '',
        builtAt: kit.builtAt || null,
    };
}

// Estado (y arranque del montaje si hace falta). Tras un error, volver a consultar lo reintenta.
router.get('/kit/status', (req, res) => {
    cleanOffline();
    if (kit.status === 'idle' || kit.status === 'error') ensureKit();
    else if (kit.status === 'ready' && !fs.existsSync(kit.file)) { kit.status = 'idle'; ensureKit(); }
    res.json(publicStatus());
});

router.get('/kit/download', (req, res) => {
    if (kit.status !== 'ready' || !fs.existsSync(kit.file)) {
        if (kit.status !== 'unavailable') ensureKit();
        return res.status(503).json(publicStatus());
    }
    // res.download envía tamaño y admite rangos: el navegador muestra el progreso y puede reanudar
    res.download(kit.file, 'GameShow-Offline.zip');
});

// ── Juego offline: kit + juego ya metido ────────────────────────────────────
// 1. POST prepara el zip (kit + datos/importar/<juego>.gameshow.zip) y devuelve una URL de descarga.
// 2. GET descarga ese archivo. Se guarda 3 h para que el navegador pueda reanudar una descarga cortada.
// Al arrancar el kit, kit/start.js importa lo que haya en datos/importar.
//
// Disco: los zips preparados no pasan nunca de OFFLINE_CAP_MB en total (se borran primero los más
// antiguos), caducan a las 3 h y se limpian al arrancar, cada 15 min y al consultar el estado.
// Si el juego no ha cambiado, se reutiliza el mismo zip en vez de hacer otro.

const crypto = require('crypto');
const OFFLINE_DIR = path.join(CACHE_DIR, 'offline');
const OFFLINE_TTL = 3 * 3600 * 1000;
const OFFLINE_CAP_MB = Number(process.env.GAMESHOW_OFFLINE_CAP_MB) || 300;
const TEMP_TTL = 30 * 60 * 1000;      // restos de una preparación que se cortó
const READY = /^[0-9a-f]{20}\.zip$/;  // zips terminados: <huella del juego>.zip
const offline = new Map();            // token → { file, name }
const building = new Map();           // huella → preparación en curso (dos clics a la vez comparten)

// Borra lo caducado y, si hace falta, los zips más antiguos hasta que quepan `reserveBytes` más
// sin pasar del tope. `keep` no se borra nunca (el que se va a reutilizar).
function cleanOffline(reserveBytes = 0, keep = null) {
    if (IN_KIT || !fs.existsSync(OFFLINE_DIR)) return;
    const now = Date.now();
    const ready = [];
    for (const f of fs.readdirSync(OFFLINE_DIR)) {
        const p = path.join(OFFLINE_DIR, f);
        try {
            const st = fs.statSync(p);
            const age = now - st.mtimeMs;
            if (!READY.test(f)) { if (age > TEMP_TTL) fs.rmSync(p, { force: true }); continue; }
            if (age > OFFLINE_TTL && p !== keep) { fs.rmSync(p, { force: true }); continue; }
            ready.push({ p, size: st.size, mtime: st.mtimeMs });
        } catch (e) {}
    }
    ready.sort((a, b) => a.mtime - b.mtime);
    let total = ready.reduce((n, r) => n + r.size, 0);
    for (const r of ready) {
        if (total + reserveBytes <= OFFLINE_CAP_MB * 1048576) break;
        if (r.p === keep) continue;
        try { fs.rmSync(r.p, { force: true }); total -= r.size; } catch (e) {}
    }
    for (const [token, o] of offline) if (!fs.existsSync(o.file)) offline.delete(token);
}

// Huella de lo que va en el zip: kit actual + juego (sin la fecha de exportación) + archivos (tamaño y fecha)
function offlineKey(exp) {
    const { exportedAt, ...manifest } = exp.manifest;
    const files = Object.entries(exp.entries).map(([entry, abs]) => {
        try { const st = fs.statSync(abs); return [entry, st.size, st.mtimeMs]; } catch (e) { return [entry, 0, 0]; }
    });
    return crypto.createHash('sha256').update(JSON.stringify([path.basename(kit.file), exp.fileName, manifest, files])).digest('hex').slice(0, 20);
}

async function buildOffline(exp, key, file) {
    const { writeGameZip } = require('./transfer').helpers;
    const tmp = crypto.randomBytes(8).toString('hex');
    const gameZip = path.join(OFFLINE_DIR, tmp + '.game.tmp');
    const built = path.join(OFFLINE_DIR, tmp + '.kit.tmp');
    try {
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(gameZip);
            out.on('close', resolve).on('error', reject);
            writeGameZip(exp, out).on('error', reject);
        });
        await require('../kit/assemble').appendStoredFile(kit.file, 'datos/importar/' + exp.fileName, gameZip, built);
        fs.renameSync(built, file);
    } finally {
        fs.rmSync(gameZip, { force: true });
        fs.rmSync(built, { force: true });
    }
}

router.post('/games/:id/offline-kit', async (req, res) => {
    const { collectGameExport } = require('./transfer').helpers;
    const exp = collectGameExport(req.params.id);
    if (!exp) return res.status(404).json({ error: 'juego no encontrado' });
    if (kit.status !== 'ready' || !fs.existsSync(kit.file)) {
        if (kit.status !== 'unavailable') ensureKit();
        return res.status(503).json(publicStatus());
    }
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
    const key = offlineKey(exp);
    const file = path.join(OFFLINE_DIR, key + '.zip');
    let reused = fs.existsSync(file);
    try {
        if (reused) {
            const now = new Date();
            fs.utimesSync(file, now, now); // vuelve a contar las 3 h
            cleanOffline(0, file);
        } else if (building.has(key)) {
            await building.get(key);
            reused = true;
        } else {
            let gameBytes = 0;
            for (const abs of Object.values(exp.entries)) { try { gameBytes += fs.statSync(abs).size; } catch (e) {} }
            const expected = kit.size + gameBytes;
            cleanOffline(expected);
            const needMb = Math.ceil((expected + gameBytes) / 1048576) + 100;
            const free = freeMb(OFFLINE_DIR);
            if (free < needMb) return res.status(507).json({ error: `No hay espacio en el disco del servidor para prepararlo (${free} MB libres, hacen falta ~${needMb}).` });
            const job = buildOffline(exp, key, file);
            building.set(key, job);
            try { await job; } finally { building.delete(key); }
        }
    } catch (err) {
        console.error('[offline-kit]', err);
        return res.status(500).json({ error: 'No se pudo preparar: ' + err.message });
    }
    const token = crypto.randomBytes(12).toString('hex');
    const name = 'GameShow-Offline - ' + exp.fileName.replace(/\.gameshow\.zip$/, '') + '.zip';
    offline.set(token, { file, name });
    res.json({ url: '/api/offline-kit/' + token, sizeMb: Math.round(fs.statSync(file).size / 1048576), game: exp.game.name, missing: exp.manifest.missing.length, reused });
});

router.get('/offline-kit/:token', (req, res) => {
    const o = offline.get(req.params.token);
    if (!o || !fs.existsSync(o.file)) return res.status(404).json({ error: 'Esta descarga ha caducado: vuelve a pulsar «Juego offline».' });
    res.download(o.file, o.name);
});

// En Render: preparar el kit al arrancar, sin estorbar el arranque. En todas partes (salvo en el
// kit): limpiar los zips de «juego offline» al arrancar y cada 15 min.
function prepareInBackground() {
    if (IN_KIT) return;
    if (process.env.RENDER) setTimeout(ensureKit, 15000).unref();
    cleanOffline();
    setInterval(() => cleanOffline(), 15 * 60 * 1000).unref();
}

module.exports = { router, prepareInBackground, ensureKit, kitStatus: () => kit };
