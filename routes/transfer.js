// Exportar / importar un juego completo como .zip (para llevarlo de online a offline y viceversa,
// o como copia de seguridad).
//
// Contenido del zip:
//   game.json          → juego, rondas y preguntas (tal cual están en la BD) + mapa url → archivo
//   files/<tipo>/<f>   → cada archivo de /uploads que usa el juego (images | audio | videos)
//
// Al importar se crea un juego NUEVO. Si un archivo ya existe con el mismo nombre y contenido se
// reutiliza; si existe con otro contenido se guarda con otro nombre y se corrigen las referencias.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const yauzl = require('yauzl');
const { db } = require('../db');
const { UPLOADS_DIR, sanitizeName, uniqueName, kindOf, gameUploadUrls } = require('./uploads').helpers;

const router = express.Router();

const FORMAT = 'gameshow-export';
const VERSION = 1;
const ALREADY_COMPRESSED = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v|mp3|m4a|aac|ogg|opus|flac)$/i;

const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;

// URL de /uploads → ruta en disco (o null si sale de la carpeta o no se puede decodificar)
function resolveUpload(url) {
    try {
        const rel = decodeURIComponent(url.slice('/uploads/'.length));
        const abs = path.join(UPLOADS_DIR, rel);
        if (!abs.startsWith(UPLOADS_DIR + path.sep)) return null;
        return { rel: rel.split(path.sep).join('/'), abs };
    } catch { return null; }
}

// ───────────────── Exportar ─────────────────

router.get('/games/:id/export-zip', (req, res) => {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });

    const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(game.id).map(r => ({
        name: r.name, type: r.type, sort_order: r.sort_order, config: r.config,
        questions: db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sort_order, id').all(r.id)
            .map(q => ({ sort_order: q.sort_order, content: q.content, media_url: q.media_url, config: q.config })),
    }));

    const files = {};      // url (tal como aparece en el juego) → entrada del zip
    const entries = {};    // entrada del zip → ruta en disco
    const missing = [];
    for (const url of gameUploadUrls(game.id)) {
        const f = resolveUpload(url);
        if (!f || !fs.existsSync(f.abs) || !fs.statSync(f.abs).isFile()) { missing.push(url); continue; }
        const entry = 'files/' + f.rel;
        files[url] = entry;
        entries[entry] = f.abs;
    }

    const manifest = {
        format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
        game: { name: game.name, date: game.date, status: game.status, note: game.note, theme: game.theme, access_code: game.access_code },
        rounds, files, missing,
    };

    res.attachment(sanitizeName(game.name).base + '.gameshow.zip');
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('warning', (err) => console.warn('[export-zip]', err.message));
    zip.on('error', (err) => { console.error('[export-zip]', err); res.destroy(err); });
    zip.pipe(res);
    zip.append(JSON.stringify(manifest, null, 2), { name: 'game.json' });
    for (const [entry, abs] of Object.entries(entries)) zip.file(abs, { name: entry, store: ALREADY_COMPRESSED.test(entry) });
    zip.finalize();
});

// ───────────────── Importar ─────────────────

const TMP_DIR = path.join(UPLOADS_DIR, '..', 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const zipUpload = multer({ dest: TMP_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

function openZip(file) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) =>
            err ? reject(new Error('El archivo no es un .zip válido o está incompleto')) : resolve(zip));
    });
}

function listEntries(zip) {
    return new Promise((resolve, reject) => {
        const map = new Map();
        zip.on('entry', (e) => { if (!/\/$/.test(e.fileName)) map.set(e.fileName, e); zip.readEntry(); });
        zip.on('end', () => resolve(map));
        zip.on('error', reject);
        zip.readEntry();
    });
}

function entryStream(zip, entry) {
    return new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => err ? reject(err) : resolve(s)));
}

async function readEntryText(zip, entry) {
    const s = await entryStream(zip, entry);
    const chunks = [];
    for await (const c of s) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

// Extrae una entrada a un archivo temporal calculando su hash
async function extractToTemp(zip, entry) {
    const tmp = path.join(TMP_DIR, 'imp_' + crypto.randomBytes(6).toString('hex'));
    const hash = crypto.createHash('sha1');
    const s = await entryStream(zip, entry);
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        s.on('data', (c) => hash.update(c));
        s.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        s.pipe(out);
    });
    return { tmp, sha1: hash.digest('hex') };
}

function sha1File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha1');
        fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

function moveFile(from, to) {
    try { fs.renameSync(from, to); }
    catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
    }
}

async function importZip(zipPath) {
    const zip = await openZip(zipPath);
    try {
        const entries = await listEntries(zip);
        const manifestEntry = entries.get('game.json');
        if (!manifestEntry) throw new Error('El archivo no es una exportación de GameShow (falta game.json)');
        let m;
        try { m = JSON.parse(await readEntryText(zip, manifestEntry)); } catch { throw new Error('game.json no es válido'); }
        if (m.format !== FORMAT) throw new Error('El archivo no es una exportación de GameShow');
        if (m.version > VERSION) throw new Error('La exportación es de una versión más nueva de GameShow; actualiza la app');
        if (!m.game || !m.game.name || !Array.isArray(m.rounds)) throw new Error('game.json incompleto');

        const urlMap = {};   // url original → url nueva
        const stats = { imported: 0, reused: 0, renamed: 0 };
        const missing = Array.isArray(m.missing) ? m.missing.slice() : [];

        for (const [url, entryName] of Object.entries(m.files || {})) {
            const match = /^files\/(images|audio|videos)\/([^/]+)$/.exec(entryName);
            const entry = entries.get(entryName);
            if (!match || !entry || kindOf(match[2]) !== match[1]) { missing.push(url); continue; }
            const type = match[1];
            const destDir = path.join(UPLOADS_DIR, type);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            const { tmp, sha1 } = await extractToTemp(zip, entry);
            const original = path.basename(match[2]);
            const existing = path.join(destDir, original);
            let finalName;
            if (fs.existsSync(existing) && fs.statSync(existing).size === fs.statSync(tmp).size && await sha1File(existing) === sha1) {
                fs.unlinkSync(tmp);         // mismo archivo ya presente → reutilizar
                finalName = original;
                stats.reused++;
            } else if (!fs.existsSync(existing) && /^[\w.\-]+$/.test(original)) {
                finalName = original;       // nombre libre y seguro → se conserva tal cual
                moveFile(tmp, existing);
                stats.imported++;
            } else {
                const { base, ext } = sanitizeName(original);
                finalName = uniqueName(destDir, base, ext);
                moveFile(tmp, path.join(destDir, finalName));
                stats.imported++;
                if (fs.existsSync(existing)) stats.renamed++; // solo cuenta si chocaba con otro archivo
            }
            const newUrl = '/uploads/' + type + '/' + encodeURIComponent(finalName);
            if (newUrl !== url) urlMap[url] = newUrl;
        }

        // Reescribe referencias (las URLs más largas primero para no pisar prefijos)
        const keys = Object.keys(urlMap).sort((a, b) => b.length - a.length);
        const rw = (v) => {
            if (v == null) return v;
            let s = String(v);
            for (const k of keys) s = s.split(k).join(urlMap[k]);
            return s;
        };

        const g = m.game;
        const gameId = newId('g');
        const insert = db.transaction(() => {
            db.prepare('INSERT INTO games (id, name, date, status, note, theme, access_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(gameId, String(g.name), g.date || null, ['draft', 'published', 'archived'].includes(g.status) ? g.status : 'draft',
                    g.note || null, rw(g.theme), g.access_code || null);
            const insRound = db.prepare('INSERT INTO rounds (id, game_id, name, type, sort_order, config) VALUES (?, ?, ?, ?, ?, ?)');
            const insQ = db.prepare('INSERT INTO questions (id, round_id, sort_order, content, media_url, config) VALUES (?, ?, ?, ?, ?, ?)');
            m.rounds.forEach((r, ri) => {
                const roundId = newId('r');
                insRound.run(roundId, gameId, String(r.name || 'Ronda'), String(r.type), r.sort_order ?? ri, rw(r.config));
                (r.questions || []).forEach((q, qi) => {
                    insQ.run(newId('q'), roundId, q.sort_order ?? qi, rw(q.content) || '{}', rw(q.media_url), rw(q.config));
                });
            });
        });
        insert();

        return { gameId, name: g.name, rounds: m.rounds.length, files: stats, missing };
    } finally {
        zip.close();
    }
}

router.post('/games/import-zip', zipUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    try {
        res.status(201).json(await importZip(req.file.path));
    } catch (err) {
        console.error('[import-zip]', err.message);
        res.status(400).json({ error: err.message || 'No se pudo importar' });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

module.exports = router;
