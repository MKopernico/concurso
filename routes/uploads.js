// Rutas para subir imágenes y audio (spec §10.3).
// Los archivos se guardan en /uploads/{images,audio}/ con nombre original saneado + anti-colisión.
// En producción (Render), usa /data/uploads/ (disco persistente). En local, ./uploads/.
// Acentos transliterados, espacios→guion, [a-z0-9-] only, sufijo -2/-3… si colisión.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const sizeOf = require('image-size');
const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();

const { UPLOADS_DIR } = require('../paths');

// Crear subdirectorios al cargar el módulo
[path.join(UPLOADS_DIR, 'images'), path.join(UPLOADS_DIR, 'audio'), path.join(UPLOADS_DIR, 'videos')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log('[Uploads] Directorio de uploads:', UPLOADS_DIR);

const ACCENT_MAP = { 'á':'a','à':'a','ä':'a','â':'a','ã':'a','å':'a','é':'e','è':'e','ë':'e','ê':'e','í':'i','ì':'i','ï':'i','î':'i','ó':'o','ò':'o','ö':'o','ô':'o','õ':'o','ú':'u','ù':'u','ü':'u','û':'u','ñ':'n','ç':'c','ý':'y','ÿ':'y' };

function sanitizeName(original) {
    const { name, ext } = path.parse(original);
    let safe = name.toLowerCase()
        .replace(/[^\x00-\x7F]/g, ch => ACCENT_MAP[ch] || '')
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9\-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
    return { base: safe || 'archivo', ext: ext.toLowerCase() };
}

function uniqueName(dest, base, ext) {
    let candidate = base + ext;
    if (!fs.existsSync(path.join(dest, candidate))) return candidate;
    let n = 2;
    while (fs.existsSync(path.join(dest, base + '-' + n + ext))) n++;
    return base + '-' + n + ext;
}

// La extensión la decide el tipo del archivo, no su nombre: un "foto.html" declarado como
// image/png se guarda como .png (y nunca se sirve como página desde nuestro dominio).
const EXT_BY_MIME = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/aac': '.aac', 'audio/mp4': '.m4a',
    'video/mp4': '.mp4', 'video/webm': '.webm',
};

function makeStorage(subfolder) {
    const dest = path.join(UPLOADS_DIR, subfolder);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    return multer.diskStorage({
        destination: dest,
        filename: (req, file, cb) => {
            const { base } = sanitizeName(file.originalname);
            const ext = EXT_BY_MIME[file.mimetype] || '.bin';
            cb(null, uniqueName(dest, base, ext));
        }
    });
}

const imageUpload = multer({
    storage: makeStorage('images'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        // Desde los iPads (sin sesión) no se admite SVG: puede llevar código
        const allowed = req.isStaff ? /^image\/(jpeg|png|gif|webp|svg\+xml)$/ : /^image\/(jpeg|png|gif|webp)$/;
        if (allowed.test(file.mimetype)) cb(null, true);
        else cb(new Error(req.isStaff ? 'Solo se admiten imágenes (jpg, png, gif, webp, svg)' : 'Solo se admiten fotos (jpg, png, gif, webp)'));
    }
});

// La subida de imágenes es la única abierta a los iPads (foto del equipo): exige el pase del
// juego (cabeceras X-Game / X-Game-Pass) y tiene un límite de subidas por IP.
const photoLimiter = auth.makeLimiter(40, 10 * 60 * 1000);
function imageUploadAccess(req, res, next) {
    if (auth.isStaffRequest(req, res)) { req.isStaff = true; return next(); }
    const gameId = req.get('X-Game');
    if (!gameId || !auth.verifyGamePass(gameId, req.get('X-Game-Pass'))) return res.status(403).json({ error: 'pase de juego no válido' });
    if (photoLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Demasiadas subidas. Espera unos minutos.' });
    photoLimiter.fail(req.ip); // cuenta cada subida
    next();
}

const audioUpload = multer({
    storage: makeStorage('audio'),
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^audio\/(mpeg|mp3|wav|ogg|aac|mp4)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se admiten audios (mp3, wav, ogg, aac)'));
    }
});

router.post('/upload/image', imageUploadAccess, imageUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    const result = { url: `/uploads/images/${req.file.filename}`, originalName: req.file.originalname };
    try {
        const dims = sizeOf(req.file.path);
        result.width = dims.width;
        result.height = dims.height;
    } catch (e) { /* dimensiones no disponibles — no bloquea la subida */ }
    res.json(result);
});

router.post('/upload/audio', audioUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    res.json({ url: `/uploads/audio/${req.file.filename}`, originalName: req.file.originalname });
});

const videoUpload = multer({
    storage: makeStorage('videos'),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^video\/(mp4|webm)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se admiten vídeos (mp4, webm)'));
    }
});

router.post('/upload/video', videoUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    res.json({ url: `/uploads/videos/${req.file.filename}`, originalName: req.file.originalname });
});

// ───────────── Media Library: list files ─────────────

router.get('/media/:type', (req, res) => {
    const type = req.params.type;
    if (type !== 'images' && type !== 'audio' && type !== 'videos') return res.status(400).json({ error: 'tipo inválido (images|audio|videos)' });
    const dir = path.join(UPLOADS_DIR, type);
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir)
        .filter(f => !f.startsWith('.'))
        .map(f => {
            const stat = fs.statSync(path.join(dir, f));
            return { name: f, url: `/uploads/${type}/${f}`, size: stat.size, modified: stat.mtimeMs };
        })
        .sort((a, b) => b.modified - a.modified);
    res.json(files);
});

// ───────────── Media Library: delete file ─────────────

router.delete('/media/:type/:filename', (req, res) => {
    const { type, filename } = req.params;
    if (type !== 'images' && type !== 'audio' && type !== 'videos') return res.status(400).json({ error: 'tipo inválido' });
    // Sanitize filename to prevent path traversal
    const safe = path.basename(filename);
    const filePath = path.join(UPLOADS_DIR, type, safe);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'archivo no encontrado' });
    // ¿Lo usa algún juego o la playlist? Entonces hace falta confirmación (?force=1)
    if (!req.query.force) {
        const url = '/uploads/' + type + '/' + safe;
        const inUse = [];
        for (const g of db.prepare('SELECT id, name FROM games').all()) {
            const urls = gameUploadUrls(g.id);
            if (urls && [...urls].some(x => { try { return decodeURIComponent(x) === url; } catch { return x === url; } })) inUse.push('Juego «' + g.name + '»');
        }
        if (readPlaylist().some(x => { try { return decodeURIComponent(x) === url; } catch { return x === url; } })) inUse.push('Playlist de música por defecto');
        if (inUse.length) return res.status(409).json({ error: 'El archivo está en uso', inUse });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

// ───────────── Global default playlist (JSON on persistent disk) ─────────────

const CONFIG_DIR = path.join(UPLOADS_DIR, '..', 'config');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
const PLAYLIST_PATH = path.join(CONFIG_DIR, 'default-playlist.json');

function readPlaylist() {
    if (!fs.existsSync(PLAYLIST_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(PLAYLIST_PATH, 'utf8')).playlist || []; }
    catch { return []; }
}

function writePlaylist(list) {
    fs.writeFileSync(PLAYLIST_PATH, JSON.stringify({ playlist: list }), 'utf8');
}

router.get('/audio/default-playlist', (req, res) => {
    res.json({ playlist: readPlaylist() });
});

router.put('/audio/default-playlist', express.json(), (req, res) => {
    const { playlist } = req.body || {};
    if (!Array.isArray(playlist) || !playlist.every(u => typeof u === 'string')) {
        return res.status(400).json({ error: 'playlist debe ser un array de strings' });
    }
    writePlaylist(playlist);
    res.json({ playlist });
});

// ───────────── Precarga: lista de archivos de un juego por dispositivo ─────────────
// Devuelve solo URLs + tamaño + versión (nunca el contenido de las preguntas).
//   role=play     → imágenes (requiere pase del juego)
//   role=screen   → imágenes + vídeos (público, igual que /screen)
//   role=director → imágenes + audio + playlist por defecto (requiere sesión)

const KIND_BY_EXT = {
    images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp'],
    videos: ['mp4', 'webm', 'mov', 'm4v'],
    audio:  ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
};
const ROLE_KINDS = { play: ['images'], screen: ['images', 'videos'], director: ['images', 'audio'] };

function kindOf(url) {
    const ext = path.extname(url).slice(1).toLowerCase();
    return Object.keys(KIND_BY_EXT).find(k => KIND_BY_EXT[k].includes(ext)) || null;
}

function gameUploadUrls(gameId) {
    const g = db.prepare('SELECT theme FROM games WHERE id = ?').get(gameId);
    if (!g) return null;
    const blobs = [g.theme];
    db.prepare('SELECT id, config FROM rounds WHERE game_id = ?').all(gameId).forEach(r => {
        blobs.push(r.config);
        db.prepare('SELECT content, media_url, config FROM questions WHERE round_id = ?').all(r.id)
            .forEach(q => blobs.push(q.content, q.media_url, q.config));
    });
    const urls = new Set();
    const re = /\/uploads\/[^\s"'()<>?#\\]+/g;
    blobs.filter(Boolean).forEach(b => (String(b).match(re) || []).forEach(u => urls.add(u)));
    return urls;
}

router.get('/games/:id/assets', (req, res) => {
    const role = req.query.role;
    if (!ROLE_KINDS[role]) return res.status(400).json({ error: 'role inválido (play|screen|director)' });
    if (role === 'play' && !auth.verifyGamePass(req.params.id, req.query.pass)) return res.status(403).json({ error: 'pase no válido' });
    if (role === 'director' && !auth.isStaffRequest(req, res)) return res.status(401).json({ error: 'sesión requerida', auth: true });

    const urls = gameUploadUrls(req.params.id);
    if (!urls) return res.status(404).json({ error: 'juego no encontrado' });
    if (role === 'director') readPlaylist().forEach(u => { if (String(u).startsWith('/uploads/')) urls.add(u); });

    const kinds = ROLE_KINDS[role];
    const files = [], missing = [];
    for (const url of urls) {
        const kind = kindOf(url);
        if (!kinds.includes(kind)) continue;
        let rel;
        try { rel = decodeURIComponent(url.slice('/uploads/'.length)); } catch { missing.push(url); continue; }
        const abs = path.join(UPLOADS_DIR, rel);
        if (!abs.startsWith(UPLOADS_DIR) || !fs.existsSync(abs)) { missing.push(url); continue; }
        const st = fs.statSync(abs);
        files.push({ url, kind, size: st.size, ver: st.size + '-' + Math.floor(st.mtimeMs) });
    }
    res.json({ files, missing, totalBytes: files.reduce((a, f) => a + f.size, 0) });
});

// ───────────── Template download (dynamic) ─────────────

// Plantilla con ejemplos (?ejemplo=1): una pregunta de cada tipo, lista para importar y jugar.
// Las imágenes de muestra vienen con la app (/shared), así el ejemplo funciona sin subir nada.
const EJ_IMG = '/shared/ejemplo-paisaje.svg';
const EXAMPLE_ROUNDS = [
    ['Ejemplo · Multirespuesta', 'multirespuesta', 20, 500, 'si', 0, '', ''],
    ['Ejemplo · Pulsador', 'pulsador', '', 500, '', 0, '', ''],
    ['Ejemplo · Precio justo', 'precio', 20, 500, 'si', 0, '', ''],
    ['Ejemplo · Boom', 'boom', 30, 500, 'si', 0, '', ''],
    ['Ejemplo · Ruleta', 'ruleta', '', 500, '', 0, '', ''],
    ['Ejemplo · Adivina la imagen', 'imagen', '', 500, '', 0, '', ''],
    ['Ejemplo · Imagen fija', 'imagen_fija', '', 500, '', 0, '', ''],
    ['Ejemplo · Adivina la canción', 'cancion', '', 500, '', 0, '', ''],
    ['Ejemplo · Identidad', 'identidad', 60, 500, 'si', 0, '', ''],
    ['Ejemplo · Imagen que se aclara', 'aclara', '', 500, '', 0, '', ''],
    ['Ejemplo · Respuesta abierta', 'abierta', '', 500, 'si', 0, '', ''],
    ['Ejemplo · Pictionary', 'pictionary', 60, 500, 'si', 0, '', ''],
];
const EXAMPLE_ROWS = {
    multirespuesta: [['Ejemplo · Multirespuesta', '¿Cuál es el río más largo de la península ibérica?', 'Ebro', 'Tajo', 'Duero', 'Guadalquivir', '', '2', 'El Tajo mide unos 1.007 km.', 20, 500, 'si', 0]],
    pulsador: [['Ejemplo · Pulsador', '¿En qué año llegó el ser humano a la Luna?', '1969', 'Fue en verano', 'Neil Armstrong', '', 500, 0]],
    precio: [['Ejemplo · Precio justo', '¿Cuántos kilómetros hay de la Tierra a la Luna?', 384400, '/shared/placeholder-precio.svg', 20, 500]],
    boom: [['Ejemplo · Boom', 'Ordena del invento más antiguo al más moderno', 'Teléfono móvil', 'Imprenta', 'Rueda', 'Bombilla', '', '3,2,4,1', 30, 500, 'si']],
    ruleta: [['Ejemplo · Ruleta', 'Refrán', 'Más vale tarde que nunca', 500, '']],
    imagen: [['Ejemplo · Adivina la imagen', '¿Qué paisaje es?', 'Montañas junto a un lago', EJ_IMG, 500]],
    imagen_fija: [['Ejemplo · Imagen fija', '¿A qué hora del día es esta imagen?', EJ_IMG, '', 'Al amanecer', 'si', '', '', '', 500]],
    cancion: [['Ejemplo · Adivina la canción', '¿Qué canción es?', 'Cumpleaños feliz', '', '', 100, 'default', 500]],
    identidad: [
        ['Ejemplo · Identidad', 'Empareja cada país con su capital', '', 'España', '', 'Madrid', 'Cuatro capitales europeas', 500, 60],
        ['Ejemplo · Identidad', '', '', 'Francia', '', 'París'],
        ['Ejemplo · Identidad', '', '', 'Italia', '', 'Roma'],
        ['Ejemplo · Identidad', '', '', 'Portugal', '', 'Lisboa'],
    ],
    aclara: [['Ejemplo · Imagen que se aclara', '¿Qué se ve en la imagen?', EJ_IMG, 'Un paisaje de montaña', 'pixelado', 'sola', 20, 500]],
    abierta: [
        ['Ejemplo · Respuesta abierta', 'Literatura y geografía: responde a las tres', '¿Quién escribió El Quijote?', 'Cervantes', 'Miguel de Cervantes / el manco de Lepanto', 90, 500, 'si'],
        ['Ejemplo · Respuesta abierta', '', '¿Cuál es la capital de Portugal?', 'Lisboa', ''],
        ['Ejemplo · Respuesta abierta', '', '¿Cuántos lados tiene un hexágono?', '6', 'seis'],
    ],
    pictionary: [
        ['Ejemplo · Pictionary', 'Torre Eiffel', 'Monumentos', 'equipo', 'auto', 50],
        ['Ejemplo · Pictionary', 'Paraguas', 'Objetos'],
        ['Ejemplo · Pictionary', 'Cepillarse los dientes', 'Acciones'],
    ],
};

router.get('/templates/importacion', (req, res) => {
    const withExamples = req.query.ejemplo === '1';
    let XLSX;
    try { XLSX = require('xlsx'); } catch { return res.status(500).json({ error: 'Módulo xlsx no instalado' }); }

    const { EXCEL_TYPE_DEFS, buildInstructionRows } = require('./games');

    const wb = XLSX.utils.book_new();

    // Instructions sheet first (shared with export)
    const wsInstr = XLSX.utils.aoa_to_sheet(buildInstructionRows());
    wsInstr['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsInstr, 'Instrucciones');

    // Rounds sheet (empty template)
    const ROUND_COLUMNS = ['nombre', 'tipo', 'tiempo', 'puntos', 'extra_mas_rapido', 'penalizacion', 'logo', 'fondo'];
    const wsRondas = XLSX.utils.aoa_to_sheet([
        ['Rondas'],
        [],
        ROUND_COLUMNS,
        ...(withExamples ? EXAMPLE_ROUNDS : []),
    ]);
    wsRondas['!cols'] = ROUND_COLUMNS.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, wsRondas, 'Rondas');

    // One sheet per type: row 0 = type label, row 1 = empty, row 2 = headers, row 3+ = data
    EXCEL_TYPE_DEFS.forEach(d => {
        const wsData = XLSX.utils.aoa_to_sheet([
            [d.sheet + ' (' + d.type + ')'],
            [],
            d.columns,
            ...(withExamples ? (EXAMPLE_ROWS[d.type] || []) : []),
        ]);
        wsData['!cols'] = d.columns.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(wb, wsData, d.sheet);
    });

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="' + (withExamples ? 'plantilla_gameshow_con_ejemplos.xlsx' : 'plantilla_importacion_gameshow.xlsx') + '"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
});

// Error handler de multer
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

module.exports = router;
// Reutilizados por la exportación/importación de juegos (routes/transfer.js)
module.exports.helpers = { UPLOADS_DIR, sanitizeName, uniqueName, kindOf, gameUploadUrls };
