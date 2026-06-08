// Rutas para subir imágenes y audio (spec §10.3).
// Los archivos se guardan en /uploads/{images,audio}/ con nombre único basado en timestamp + random.
// En producción (Render), usa /data/uploads/ (disco persistente). En local, ./uploads/.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sizeOf = require('image-size');

const router = express.Router();

const UPLOADS_DIR = fs.existsSync('/data') ? '/data/uploads' : path.join(__dirname, '..', 'uploads');

// Crear subdirectorios al cargar el módulo
[path.join(UPLOADS_DIR, 'images'), path.join(UPLOADS_DIR, 'audio')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log('[Uploads] Directorio de uploads:', UPLOADS_DIR);

function makeStorage(subfolder) {
    const dest = path.join(UPLOADS_DIR, subfolder);
    if (!require('fs').existsSync(dest)) require('fs').mkdirSync(dest, { recursive: true });
    return multer.diskStorage({
        destination: dest,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
            cb(null, name);
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

// ───────────── Media Library: list files ─────────────

router.get('/media/:type', (req, res) => {
    const type = req.params.type;
    if (type !== 'images' && type !== 'audio') return res.status(400).json({ error: 'tipo inválido (images|audio)' });
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
    if (type !== 'images' && type !== 'audio') return res.status(400).json({ error: 'tipo inválido' });
    // Sanitize filename to prevent path traversal
    const safe = path.basename(filename);
    const filePath = path.join(UPLOADS_DIR, type, safe);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'archivo no encontrado' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

// ───────────── Template download ─────────────

router.get('/templates/importacion', (req, res) => {
    const templatePath = path.join(__dirname, '..', 'templates', 'plantilla_importacion_gameshow.xlsx');
    if (!fs.existsSync(templatePath)) return res.status(404).json({ error: 'plantilla no encontrada' });
    res.download(templatePath, 'plantilla_importacion_gameshow.xlsx');
});

// Error handler de multer
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

module.exports = router;
