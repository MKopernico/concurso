// Rutas para subir imágenes y audio (spec §10.3).
// Los archivos se guardan en /uploads/{images,audio}/ con nombre único basado en timestamp + random.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

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
    res.json({ url: `/uploads/images/${req.file.filename}`, originalName: req.file.originalname });
});

router.post('/upload/audio', audioUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    res.json({ url: `/uploads/audio/${req.file.filename}`, originalName: req.file.originalname });
});

// Error handler de multer
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

module.exports = router;
