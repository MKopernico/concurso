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

const OFFLINE_DIR = path.join(CACHE_DIR, 'offline');
const OFFLINE_TTL = 3 * 3600 * 1000;
const offline = new Map(); // token → { file, name, createdAt }

function cleanOffline() {
    if (!fs.existsSync(OFFLINE_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(OFFLINE_DIR)) {
        const p = path.join(OFFLINE_DIR, f);
        try { if (now - fs.statSync(p).mtimeMs > OFFLINE_TTL) fs.rmSync(p, { force: true }); } catch (e) {}
    }
    for (const [token, o] of offline) if (now - o.createdAt > OFFLINE_TTL) offline.delete(token);
}

router.post('/games/:id/offline-kit', async (req, res) => {
    const { collectGameExport, writeGameZip } = require('./transfer').helpers;
    const exp = collectGameExport(req.params.id);
    if (!exp) return res.status(404).json({ error: 'juego no encontrado' });
    if (kit.status !== 'ready' || !fs.existsSync(kit.file)) {
        if (kit.status !== 'unavailable') ensureKit();
        return res.status(503).json(publicStatus());
    }
    cleanOffline();
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
    let gameBytes = 0;
    for (const abs of Object.values(exp.entries)) { try { gameBytes += fs.statSync(abs).size; } catch (e) {} }
    const needMb = Math.ceil((kit.size + 2 * gameBytes) / 1048576) + 100;
    const free = freeMb(OFFLINE_DIR);
    if (free < needMb) return res.status(507).json({ error: `No hay espacio en el disco del servidor para prepararlo (${free} MB libres, hacen falta ~${needMb}).` });

    const token = require('crypto').randomBytes(12).toString('hex');
    const gameZip = path.join(OFFLINE_DIR, token + '.game.zip');
    const file = path.join(OFFLINE_DIR, token + '.zip');
    try {
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(gameZip);
            out.on('close', resolve).on('error', reject);
            writeGameZip(exp, out).on('error', reject);
        });
        await require('../kit/assemble').appendStoredFile(kit.file, 'datos/importar/' + exp.fileName, gameZip, file);
    } catch (err) {
        console.error('[offline-kit]', err);
        fs.rmSync(file, { force: true });
        return res.status(500).json({ error: 'No se pudo preparar: ' + err.message });
    } finally {
        fs.rmSync(gameZip, { force: true });
    }
    const name = 'GameShow-Offline - ' + exp.fileName.replace(/\.gameshow\.zip$/, '') + '.zip';
    offline.set(token, { file, name, createdAt: Date.now() });
    res.json({ url: '/api/offline-kit/' + token, sizeMb: Math.round(fs.statSync(file).size / 1048576), game: exp.game.name, missing: exp.manifest.missing.length });
});

router.get('/offline-kit/:token', (req, res) => {
    const o = offline.get(req.params.token);
    if (!o || !fs.existsSync(o.file)) return res.status(404).json({ error: 'Esta descarga ha caducado: vuelve a pulsar «Juego offline».' });
    res.download(o.file, o.name);
});

// En Render: preparar el kit al arrancar, sin estorbar el arranque
function prepareInBackground() {
    if (!IN_KIT && process.env.RENDER) setTimeout(ensureKit, 15000).unref();
}

module.exports = { router, prepareInBackground, ensureKit, kitStatus: () => kit };
