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

    const { EXCEL_TYPE_DEFS } = require('./games');

    const wb = XLSX.utils.book_new();

    // Instructions sheet first
    const instrRows = [
        ['INSTRUCCIONES — Plantilla de importación GameShow'],
        [],
        ['1. Cada pestaña corresponde a un tipo de prueba.'],
        ['2. La columna "ronda" es OBLIGATORIA: cada nombre único crea una ronda nueva.'],
        ['3. Reimportar el mismo fichero DUPLICA las rondas (no machaca las existentes).'],
        ['4. Las columnas de media (imagen, audio, video) esperan la ruta del archivo'],
        ['   ya subido en el servidor (ej: /uploads/images/foto.jpg).'],
        ['   Suba los archivos desde el admin ANTES de importar el Excel.'],
        ['5. Los campos de configuración (tiempo, puntos_base, etc.) son opcionales.'],
        ['   Si se omiten, se usan los valores por defecto de la ronda.'],
        [],
        ['TIPOS DE PRUEBA:'],
    ];
    EXCEL_TYPE_DEFS.forEach(d => {
        instrRows.push(['  - ' + d.sheet + ' (' + d.type + ')']);
    });
    instrRows.push([], ['NOTAS POR TIPO:']);
    instrRows.push(['  Multirespuesta: "correctas" = números de opción separados por coma (ej: 1,3). Opciones 4 y 5 son opcionales.']);
    instrRows.push(['  Pulsador: pistas son opcionales.']);
    instrRows.push(['  Boom: "orden_correcto" = orden de los elementos separado por coma (ej: 3,1,2,4).']);
    instrRows.push(['  Ruleta: "pista" es la categoría/pista mostrada al público. "frase" se revela letra a letra.']);
    instrRows.push(['  Imagen: solo enunciado + respuesta + ruta imagen. La cuadrícula se ajusta en el admin.']);
    instrRows.push(['  Imagen Fija: usar columna "imagen" O "video" (no ambas). Pulsador: "no" para desactivar.']);
    instrRows.push(['  Cancion: caos_inicial (0-100, defecto 100), preset (defecto "default").']);

    const wsInstr = XLSX.utils.aoa_to_sheet(instrRows);
    wsInstr['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsInstr, 'Instrucciones');

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
