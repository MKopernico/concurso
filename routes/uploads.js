// Rutas para subir imágenes y audio (spec §10.3).
// Los archivos se guardan en /uploads/{images,audio}/ con nombre original saneado + anti-colisión.
// En producción (Render), usa /data/uploads/ (disco persistente). En local, ./uploads/.
// Acentos transliterados, espacios→guion, [a-z0-9-] only, sufijo -2/-3… si colisión.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const sizeOf = require('image-size');

const router = express.Router();

const UPLOADS_DIR = fs.existsSync('/data') ? '/data/uploads' : path.join(__dirname, '..', 'uploads');

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

function makeStorage(subfolder) {
    const dest = path.join(UPLOADS_DIR, subfolder);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    return multer.diskStorage({
        destination: dest,
        filename: (req, file, cb) => {
            const { base, ext } = sanitizeName(file.originalname);
            cb(null, uniqueName(dest, base, ext));
        }
    });
}

const imageUpload = multer({
    storage: makeStorage('images'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se admiten imágenes (jpg, png, gif, webp, svg)'));
    }
});

const audioUpload = multer({
    storage: makeStorage('audio'),
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^audio\/(mpeg|mp3|wav|ogg|aac|mp4)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se admiten audios (mp3, wav, ogg, aac)'));
    }
});

router.post('/upload/image', imageUpload.single('file'), (req, res) => {
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

// ───────────── Template download (dynamic) ─────────────

router.get('/templates/importacion', (req, res) => {
    let XLSX;
    try { XLSX = require('xlsx'); } catch { return res.status(500).json({ error: 'Módulo xlsx no instalado' }); }

    const { EXCEL_TYPE_DEFS, buildInstructionRows } = require('./games');

    const wb = XLSX.utils.book_new();

    // Instructions sheet first (shared with export)
    const wsInstr = XLSX.utils.aoa_to_sheet(buildInstructionRows());
    wsInstr['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsInstr, 'Instrucciones');

    // Rounds sheet (empty template)
    const ROUND_COLUMNS = ['nombre', 'tipo', 'tiempo', 'puntos_base', 'bonus_max', 'penalizacion', 'logo', 'fondo'];
    const wsRondas = XLSX.utils.aoa_to_sheet([
        ['Rondas'],
        [],
        ROUND_COLUMNS,
    ]);
    wsRondas['!cols'] = ROUND_COLUMNS.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, wsRondas, 'Rondas');

    // One sheet per type: row 0 = type label, row 1 = empty, row 2 = headers, row 3+ = data
    EXCEL_TYPE_DEFS.forEach(d => {
        const wsData = XLSX.utils.aoa_to_sheet([
            [d.sheet + ' (' + d.type + ')'],
            [],
            d.columns,
        ]);
        wsData['!cols'] = d.columns.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(wb, wsData, d.sheet);
    });

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_importacion_gameshow.xlsx"');
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
