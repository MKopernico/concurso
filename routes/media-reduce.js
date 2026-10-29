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
const { UPLOADS_DIR, REDUCED_LOG, sanitizeName, uniqueName, kindOf, gameUploadUrls } = require('./uploads').helpers;

const router = express.Router();

const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const BACKUP_DIR = path.join(IMAGES_DIR, '_originales');
const LOG_PATH = REDUCED_LOG;
const HEAVY_BYTES = 500 * 1024;
const MAX_SIDE = 1920;
const REDUCIBLE = /\.(jpe?g|png|webp)$/i;
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const TYPE_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const URL_RE = /\/uploads\/[^\s"'()<>?#\\]+/g;

function decode(u) { try { return decodeURIComponent(u); } catch { return u; } }

// Sin registro todavía → lista vacía. Si existe pero no se puede leer (antivirus, archivo a medias)
// se lanza: escribir encima borraría las redirecciones y lo que se puede deshacer.
function readLog() {
    let txt;
    try { txt = fs.readFileSync(LOG_PATH, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return JSON.parse(txt).entries || [];
}
function readLogSafe() { try { return readLog(); } catch (e) { return []; } }
function writeLog(entries) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    writeOver(LOG_PATH, Buffer.from(JSON.stringify({ entries }, null, 1), 'utf8'));
    movedCache = null;
}

// Medidas leyendo solo el principio del archivo: abrir la Biblioteca no puede leer cientos de MB
// de golpe (bloquearía el servidor y con él pulsadores y tiempos de todas las partidas)
function headOf(abs, bytes) {
    const fd = fs.openSync(abs, 'r');
    try { const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n); }
    finally { fs.closeSync(fd); }
}
// PNG o WebP animados: al dibujarlos en un lienzo se quedan en el primer fotograma
function isAnimated(buf) {
    if (buf.length > 12 && buf.toString('latin1', 1, 4) === 'PNG') {
        const idat = buf.indexOf('IDAT'), actl = buf.indexOf('acTL');
        return actl > 0 && (idat < 0 || actl < idat);
    }
    if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        return buf.toString('latin1', 12, 16) === 'VP8X' && !!(buf[20] & 0x02);
    }
    return false;
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
    const log = readLogSafe();
    const reduced = new Set(log.map(e => e.newUrl));
    const files = [];
    for (const [url, games] of refs) {
        const abs = imagePath(url);
        if (!abs || !REDUCIBLE.test(abs) || !fs.existsSync(abs)) continue;
        const size = fs.statSync(abs).size;
        const head = headOf(abs, 512 * 1024);
        if (isAnimated(head)) continue;
        const d = dimsOf(head);
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
// También acepta un Map(desde → hacia) para cambiar varias de una pasada.
function rewriteRefs(fromUrl, toUrl) {
    const map = fromUrl instanceof Map ? fromUrl : new Map([[fromUrl, toUrl]]);
    const touched = new Set();
    const rw = (v) => v == null ? v : String(v).replace(URL_RE, m => map.has(decode(m)) ? encodeURI(map.get(decode(m))) : m);
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
    let log;
    try { log = readLog(); } catch (e) { return res.status(500).json({ error: 'No se puede leer el registro de fotos reducidas: inténtalo de nuevo' }); }
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
    const newName = sameFormat ? null : uniqueName(IMAGES_DIR, base, newExt);
    const newUrl = sameFormat ? url : '/uploads/images/' + newName;
    let games = 0;
    // El registro va antes de tocar archivos: si algo falla a mitad, la original sigue localizable
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), url, newUrl, backup, before, after: f.size, width: d.width, height: d.height };
    writeLog(log.concat(entry));
    if (sameFormat) {
        fs.copyFileSync(abs, path.join(BACKUP_DIR, backup));
        writeOver(abs, f.buffer);
    } else {
        fs.writeFileSync(path.join(IMAGES_DIR, newName), f.buffer);
        fs.renameSync(abs, path.join(BACKUP_DIR, backup));
        games = rewriteRefs(url, newUrl);
    }
    res.json({ ok: true, url: newUrl, renamed: newUrl !== url, games, before, after: f.size, width: d.width, height: d.height });
});

// Deshacer: de la más reciente a la más antigua (si una foto se redujo dos veces, al final queda
// la original de verdad). Lo que no se puede deshacer (copia borrada a mano) se queda en el registro.
router.post('/media/images/restore', (req, res) => {
    let log;
    try { log = readLog(); } catch (e) { return res.status(500).json({ error: 'No se puede leer el registro de fotos reducidas: inténtalo de nuevo' }); }
    let restored = 0, pending = 0;
    for (const e of log.slice().reverse()) {
        const backupAbs = path.join(BACKUP_DIR, path.basename(e.backup));
        const origAbs = imagePath(e.url), curAbs = imagePath(e.newUrl);
        // Solo si lo que hay en la URL es todavía la foto que se dejó (si la cambiaron, no se pisa)
        const ours = curAbs && fs.existsSync(curAbs) && fs.statSync(curAbs).size === e.after;
        if (!origAbs || !curAbs || !fs.existsSync(backupAbs) || !ours) { pending++; continue; }
        if (e.newUrl === e.url) {
            writeOver(origAbs, fs.readFileSync(backupAbs));
            fs.unlinkSync(backupAbs);
        } else {
            if (fs.existsSync(origAbs)) { pending++; continue; } // alguien subió otra con ese nombre
            fs.renameSync(backupAbs, origAbs);
            rewriteRefs(e.newUrl, e.url);
            // La reducida se queda (no se lista): partidas, copias y Excel con la URL nueva siguen viéndose
        }
        writeLog(readLog().filter(x => x.id !== e.id)); // al momento: si algo falla luego, esta ya está hecha
        restored++;
    }
    res.json({ ok: true, restored, pending });
});

// URL vieja de una foto que cambió de formato → la nueva (montado tras express.static('/uploads'):
// solo se llega aquí si el archivo ya no existe).
let movedCache = null;
function movedRedirect(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!movedCache) {
        movedCache = new Map();
        for (const e of readLogSafe()) if (e.newUrl !== e.url) movedCache.set(e.url, e.newUrl);
    }
    let to = movedCache.get(decode('/uploads' + req.path));
    for (let i = 0; i < 5 && to && movedCache.has(to); i++) to = movedCache.get(to); // reducida dos veces
    if (!to) return next();
    res.redirect(302, encodeURI(to));
}

// Un Excel antiguo, un juego importado o un formulario abierto desde antes pueden volver a meter
// la URL vieja de una foto que cambió de formato: se cambia por la nueva en cuanto se guarda (si
// no, la precarga la daría por perdida y el juego offline se iría sin ella).
function fixMovedRefs() {
    const map = new Map();
    for (const e of readLogSafe()) if (e.newUrl !== e.url) map.set(e.url, e.newUrl);
    if (!map.size) return 0;
    for (const [from, to] of map) { // reducida dos veces: directamente a la última
        let t = to;
        for (let i = 0; i < 5 && map.has(t); i++) t = map.get(t);
        if (fs.existsSync(imagePath(from) || '') || !fs.existsSync(imagePath(t) || '')) map.delete(from);
        else map.set(from, t);
    }
    return map.size ? rewriteRefs(map) : 0;
}

// Errores de multer (foto de más de 10 MB…) como JSON, igual que en routes/uploads.js
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message) return res.status(400).json({ error: err.message });
    next(err);
});

module.exports = router;
module.exports.movedRedirect = movedRedirect;
module.exports.fixMovedRefs = fixMovedRefs;
