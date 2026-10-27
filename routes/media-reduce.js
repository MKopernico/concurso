// «🗜 Reducir fotos pesadas» (Biblioteca de medios): las fotos subidas antes de que el navegador
// las redujera al subir siguen pesando varios MB y hacen lenta la precarga de los iPads.
// El servidor no puede reducirlas (sin librerías de imagen nativas): las reduce el backoffice con
// shared/image-shrink.js y las sube aquí. Este módulo:
//   GET  /media/images/heavy    → fotos usadas por algún juego con más de 500 KB o más de 1920 px
//   POST /media/images/replace  → { url, file } cambia la foto por la reducida
//   POST /media/images/restore  → vuelve a poner todas las originales (deshacer)
// Mismo formato (JPEG → JPEG, PNG → PNG): se sobrescribe en su sitio y la URL no cambia (la
// precarga ve otra versión, tamaño + fecha, y los iPads la vuelven a bajar). Formato distinto
// (PNG opaco → JPEG, logo transparente → WebP): archivo nuevo con su extensión y se cambian las
// referencias en todos los juegos; la URL vieja redirige a la nueva (partidas en marcha, Excel).
// La original se guarda siempre en uploads/images/_originales/ y el registro en config/.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { imageSize } = require('image-size');
const { db } = require('../db');
const { UPLOADS_DIR, sanitizeName, uniqueName, kindOf, gameUploadUrls } = require('./uploads').helpers;

const router = express.Router();

const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const BACKUP_DIR = path.join(IMAGES_DIR, '_originales');
const LOG_PATH = path.join(UPLOADS_DIR, '..', 'config', 'fotos-reducidas.json');
const HEAVY_BYTES = 500 * 1024;
const MAX_SIDE = 1920;
const REDUCIBLE = /\.(jpe?g|png|webp)$/i;
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const TYPE_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const URL_RE = /\/uploads\/[^\s"'()<>?#\\]+/g;

function decode(u) { try { return decodeURIComponent(u); } catch { return u; } }

function readLog() {
    try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')).entries || []; } catch { return []; }
}
function writeLog(entries) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify({ entries }, null, 1), 'utf8');
    movedCache = null;
}

// Fotos de la carpeta images/ que usa algún juego → Map(urlDecodificada → [nombres de juego])
function referencedImages() {
    const map = new Map();
    for (const g of db.prepare('SELECT id, name FROM games').all()) {
        for (const u of gameUploadUrls(g.id) || []) {
            const url = decode(u);
            if (!url.startsWith('/uploads/images/') || kindOf(url) !== 'images') continue;
            if (!map.has(url)) map.set(url, []);
            if (!map.get(url).includes(g.name)) map.get(url).push(g.name);
        }
    }
    return map;
}

// '/uploads/images/x.png' → ruta en disco (solo archivos sueltos de images/, nunca _originales)
function imagePath(url) {
    const m = /^\/uploads\/images\/([^/\\]+)$/.exec(decode(String(url || '')));
    if (!m || m[1].startsWith('.') || m[1] === '_originales') return null;
    return path.join(IMAGES_DIR, m[1]);
}

function dimsOf(buf) { try { return imageSize(buf); } catch { return {}; } }

router.get('/media/images/heavy', (req, res) => {
    const refs = referencedImages();
    const log = readLog();
    const reduced = new Set(log.map(e => e.newUrl));
    const files = [];
    for (const [url, games] of refs) {
        const abs = imagePath(url);
        if (!abs || !REDUCIBLE.test(abs) || !fs.existsSync(abs)) continue;
        const size = fs.statSync(abs).size;
        const d = dimsOf(fs.readFileSync(abs));
        const big = Math.max(d.width || 0, d.height || 0) > MAX_SIDE;
        // Ya reducida y de 1920 px o menos: aunque pase de 500 KB (foto con mucho detalle), volver a
        // comprimirla no ahorra casi nada y solo pierde calidad
        if (big || (size > HEAVY_BYTES && !reduced.has(url))) {
            files.push({ url, name: path.basename(abs), size, width: d.width || null, height: d.height || null, games });
        }
    }
    files.sort((a, b) => b.size - a.size);
    res.json({ files, referenced: refs.size, totalBytes: files.reduce((a, f) => a + f.size, 0), undo: log.length, undoBytes: log.reduce((a, e) => a + e.before - e.after, 0) });
});

// Cambia las referencias a una foto en todos los juegos (tema, rondas y preguntas). Se compara la
// URL decodificada (una referencia puede estar escrita con %20) y se respeta lo que la siga.
function rewriteRefs(fromUrl, toUrl) {
    const touched = new Set();
    const rw = (v) => v == null ? v : String(v).replace(URL_RE, m => decode(m) === fromUrl ? encodeURI(toUrl) : m);
    db.transaction(() => {
        const upGame = db.prepare('UPDATE games SET theme = ? WHERE id = ?');
        for (const g of db.prepare('SELECT id, theme FROM games').all()) {
            const t = rw(g.theme);
            if (t !== g.theme) { upGame.run(t, g.id); touched.add(g.id); }
        }
        const upRound = db.prepare('UPDATE rounds SET config = ? WHERE id = ?');
        for (const r of db.prepare('SELECT id, game_id, config FROM rounds').all()) {
            const c = rw(r.config);
            if (c !== r.config) { upRound.run(c, r.id); touched.add(r.game_id); }
        }
        const upQ = db.prepare('UPDATE questions SET content = ?, media_url = ?, config = ? WHERE id = ?');
        for (const q of db.prepare('SELECT q.id, q.content, q.media_url, q.config, r.game_id FROM questions q JOIN rounds r ON r.id = q.round_id').all()) {
            const c = rw(q.content), m = rw(q.media_url), k = rw(q.config);
            if (c !== q.content || m !== q.media_url || k !== q.config) { upQ.run(c, m, k, q.id); touched.add(q.game_id); }
        }
    })();
    // Coordinadores e iPads con la escaleta al día (la pregunta en curso no se toca: la URL vieja redirige)
    for (const id of touched) { try { require('../sockets/game').roundsChanged(id); } catch (e) { /* sin sockets (tests) */ } }
    return touched.size;
}

// Escribir encima sin dejar nunca el archivo a medias: primero a un temporal y luego renombrar
function writeOver(abs, buf) {
    const tmp = abs + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, abs); }
    catch (e) { fs.rmSync(tmp, { force: true }); fs.writeFileSync(abs, buf); }
}

const replaceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/media/images/replace', replaceUpload.single('file'), (req, res) => {
    const url = decode(String(req.body && req.body.url || ''));
    const abs = imagePath(url);
    if (!abs || !REDUCIBLE.test(abs)) return res.status(400).json({ error: 'URL de foto no válida' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'La foto ya no existe' });
    if (!referencedImages().has(url)) return res.status(400).json({ error: 'Ningún juego usa esta foto' });
    const f = req.file;
    if (!f || !EXT_BY_MIME[f.mimetype]) return res.status(400).json({ error: 'Falta la foto reducida (jpg, png o webp)' });
    const d = dimsOf(f.buffer);
    if (d.type !== TYPE_BY_MIME[f.mimetype] || !d.width) return res.status(400).json({ error: 'La foto reducida está dañada' });
    const before = fs.statSync(abs).size;
    if (f.size >= before) return res.status(400).json({ error: 'La foto reducida no pesa menos que la original' });

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = path.basename(abs);
    const { base, ext } = sanitizeName(name);
    const backup = uniqueName(BACKUP_DIR, path.parse(name).name, path.extname(name));
    const newExt = EXT_BY_MIME[f.mimetype];
    const sameFormat = newExt === ext || (newExt === '.jpg' && ext === '.jpeg');
    let newUrl = url, games = 0;
    if (sameFormat) {
        fs.copyFileSync(abs, path.join(BACKUP_DIR, backup));
        writeOver(abs, f.buffer);
    } else {
        const newName = uniqueName(IMAGES_DIR, base, newExt);
        fs.writeFileSync(path.join(IMAGES_DIR, newName), f.buffer);
        fs.renameSync(abs, path.join(BACKUP_DIR, backup));
        newUrl = '/uploads/images/' + newName;
        games = rewriteRefs(url, newUrl);
    }
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), url, newUrl, backup, before, after: f.size, width: d.width, height: d.height };
    writeLog(readLog().concat(entry));
    res.json({ ok: true, url: newUrl, renamed: newUrl !== url, games, before, after: f.size, width: d.width, height: d.height });
});

// Deshacer: de la más reciente a la más antigua (si una foto se redujo dos veces, al final queda
// la original de verdad). Lo que no se puede deshacer (copia borrada a mano) se queda en el registro.
router.post('/media/images/restore', (req, res) => {
    const log = readLog();
    const keep = [];
    let restored = 0;
    for (const e of log.slice().reverse()) {
        const backupAbs = path.join(BACKUP_DIR, path.basename(e.backup));
        const origAbs = imagePath(e.url), curAbs = imagePath(e.newUrl);
        if (!origAbs || !curAbs || !fs.existsSync(backupAbs)) { keep.unshift(e); continue; }
        if (e.newUrl === e.url) {
            writeOver(origAbs, fs.readFileSync(backupAbs));
            fs.unlinkSync(backupAbs);
        } else {
            if (fs.existsSync(origAbs)) { keep.unshift(e); continue; } // alguien subió otra con ese nombre
            fs.renameSync(backupAbs, origAbs);
            rewriteRefs(e.newUrl, e.url);
            fs.rmSync(curAbs, { force: true });
        }
        restored++;
    }
    writeLog(keep);
    res.json({ ok: true, restored, pending: keep.length });
});

// URL vieja de una foto que cambió de formato → la nueva (montado tras express.static('/uploads'):
// solo se llega aquí si el archivo ya no existe).
let movedCache = null;
function movedRedirect(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!movedCache) {
        movedCache = new Map();
        for (const e of readLog()) if (e.newUrl !== e.url) movedCache.set(e.url, e.newUrl);
    }
    let to = movedCache.get(decode('/uploads' + req.path));
    for (let i = 0; i < 5 && to && movedCache.has(to); i++) to = movedCache.get(to); // reducida dos veces
    if (!to) return next();
    res.redirect(302, encodeURI(to));
}

// Errores de multer (foto de más de 10 MB…) como JSON, igual que en routes/uploads.js
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message) return res.status(400).json({ error: err.message });
    next(err);
});

module.exports = router;
module.exports.movedRedirect = movedRedirect;
