// CRUD de juegos + rondas + preguntas (spec §10.3).
// Diseño: una sola "router factory" para que server.js sólo monte /api -> require('./routes/games').

const express = require('express');
const crypto = require('crypto');
const { db, DEFAULT_GAME_ID } = require('../db');

const router = express.Router();

// Genera un ID corto, legible y sin colisiones para juegos/rondas/preguntas.
const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;

// Parsea JSON guardado en columnas TEXT sin reventar si está vacío o malformado.
function parseJsonField(value, fallback = null) {
    if (value == null || value === '') return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

// Hidrata un juego con sus rondas/preguntas en una sola estructura anidada (usado por GET /api/games/:id).
function loadGameTree(gameId) {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) return null;
    game.theme = parseJsonField(game.theme, null);

    const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId);
    for (const r of rounds) {
        r.config = parseJsonField(r.config, {});
        r.questions = db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sort_order, id').all(r.id);
        for (const q of r.questions) {
            q.content = parseJsonField(q.content, {});
            q.config = parseJsonField(q.config, {});
        }
    }
    game.rounds = rounds;
    return game;
}

// ───────────────── GAMES ─────────────────

router.get('/games', (req, res) => {
    const rows = db.prepare('SELECT id, name, date, status, note, theme, access_code, created_at FROM games ORDER BY created_at DESC').all();
    rows.forEach(r => { r.theme = parseJsonField(r.theme, null); });
    res.json(rows);
});

router.post('/games', (req, res) => {
    const { name, date, status, note, theme, access_code } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });
    const id = newId('g');
    db.prepare(`
        INSERT INTO games (id, name, date, status, note, theme, access_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        name.trim(),
        date || null,
        status || 'draft',
        note || null,
        theme ? JSON.stringify(theme) : null,
        access_code || null
    );
    res.status(201).json(loadGameTree(id));
});

router.get('/games/:id', (req, res) => {
    const game = loadGameTree(req.params.id);
    if (!game) return res.status(404).json({ error: 'no encontrado' });
    res.json(game);
});

router.put('/games/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'no encontrado' });
    const { name, date, status, note, theme, access_code } = req.body || {};
    db.prepare(`
        UPDATE games SET
            name        = COALESCE(?, name),
            date        = COALESCE(?, date),
            status      = COALESCE(?, status),
            note        = COALESCE(?, note),
            theme       = COALESCE(?, theme),
            access_code = COALESCE(?, access_code)
        WHERE id = ?
    `).run(
        name ?? null,
        date ?? null,
        status ?? null,
        note ?? null,
        theme !== undefined ? JSON.stringify(theme) : null,
        access_code ?? null,
        req.params.id
    );
    res.json(loadGameTree(req.params.id));
});

router.delete('/games/:id', (req, res) => {
    if (req.params.id === DEFAULT_GAME_ID) {
        return res.status(400).json({ error: 'No se puede eliminar el juego por defecto' });
    }
    const info = db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'no encontrado' });
    res.status(204).end();
});

// Duplicar juego completo: copia game + rondas + preguntas con nuevos IDs (spec §5.1).
// Se hace en una sola transacción para que sea atómico.
router.post('/games/:id/duplicate', (req, res) => {
    const sourceId = req.params.id;
    const source = db.prepare('SELECT * FROM games WHERE id = ?').get(sourceId);
    if (!source) return res.status(404).json({ error: 'no encontrado' });

    const newGameId = newId('g');
    const insertGame = db.prepare(`
        INSERT INTO games (id, name, date, status, note, theme, access_code)
        VALUES (?, ?, ?, 'draft', ?, ?, ?)
    `);
    const insertRound = db.prepare(`
        INSERT INTO rounds (id, game_id, name, type, sort_order, config)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertQ = db.prepare(`
        INSERT INTO questions (id, round_id, sort_order, content, media_url, config)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(sourceId);

    db.transaction(() => {
        insertGame.run(newGameId, `${source.name} (copia)`, source.date, source.note, source.theme, source.access_code);
        for (const r of rounds) {
            const newRoundId = newId('r');
            insertRound.run(newRoundId, newGameId, r.name, r.type, r.sort_order, r.config);
            const qs = db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sort_order, id').all(r.id);
            for (const q of qs) {
                insertQ.run(newId('q'), newRoundId, q.sort_order, q.content, q.media_url, q.config);
            }
        }
    })();

    res.status(201).json(loadGameTree(newGameId));
});

// ───────────────── ROUNDS ─────────────────

router.get('/games/:id/rounds', (req, res) => {
    const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(req.params.id);
    for (const r of rounds) r.config = parseJsonField(r.config, {});
    res.json(rounds);
});

router.post('/games/:id/rounds', (req, res) => {
    const game = db.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });

    const { name, type, sort_order, config } = req.body || {};
    if (!name || !type) return res.status(400).json({ error: 'name y type son obligatorios' });

    const id = newId('r');
    // Si no llega sort_order, ponemos la nueva ronda al final.
    const order = Number.isFinite(sort_order)
        ? sort_order
        : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM rounds WHERE game_id = ?').get(req.params.id).next);

    db.prepare(`
        INSERT INTO rounds (id, game_id, name, type, sort_order, config)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, name, type, order, config ? JSON.stringify(config) : null);

    res.status(201).json({ ...db.prepare('SELECT * FROM rounds WHERE id = ?').get(id), config: config || {} });
});

router.put('/rounds/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM rounds WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'no encontrada' });

    const { name, type, sort_order, config } = req.body || {};
    db.prepare(`
        UPDATE rounds SET
            name       = COALESCE(?, name),
            type       = COALESCE(?, type),
            sort_order = COALESCE(?, sort_order),
            config     = COALESCE(?, config)
        WHERE id = ?
    `).run(
        name ?? null,
        type ?? null,
        sort_order ?? null,
        config !== undefined ? JSON.stringify(config) : null,
        req.params.id
    );
    const row = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
    row.config = parseJsonField(row.config, {});
    res.json(row);
});

router.delete('/rounds/:id', (req, res) => {
    const info = db.prepare('DELETE FROM rounds WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'no encontrada' });
    res.status(204).end();
});

// Reordenar rondas: recibe un array de IDs en el nuevo orden.
router.put('/games/:id/rounds/reorder', (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order debe ser un array de IDs' });
    const update = db.prepare('UPDATE rounds SET sort_order = ? WHERE id = ? AND game_id = ?');
    db.transaction(() => {
        order.forEach((id, idx) => update.run(idx, id, req.params.id));
    })();
    const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(req.params.id);
    for (const r of rounds) r.config = parseJsonField(r.config, {});
    res.json(rounds);
});

// ───────────────── QUESTIONS ─────────────────

router.post('/rounds/:id/questions', (req, res) => {
    const round = db.prepare('SELECT id FROM rounds WHERE id = ?').get(req.params.id);
    if (!round) return res.status(404).json({ error: 'ronda no encontrada' });

    const { content, media_url, sort_order, config } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content requerido' });

    const id = newId('q');
    const order = Number.isFinite(sort_order)
        ? sort_order
        : (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM questions WHERE round_id = ?').get(req.params.id).next);

    db.prepare(`
        INSERT INTO questions (id, round_id, sort_order, content, media_url, config)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        id,
        req.params.id,
        order,
        typeof content === 'string' ? content : JSON.stringify(content),
        media_url || null,
        config ? JSON.stringify(config) : null
    );

    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    row.content = parseJsonField(row.content, {});
    row.config = parseJsonField(row.config, {});
    res.status(201).json(row);
});

router.put('/questions/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM questions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'no encontrada' });

    const { content, media_url, sort_order, config } = req.body || {};
    db.prepare(`
        UPDATE questions SET
            content    = COALESCE(?, content),
            media_url  = COALESCE(?, media_url),
            sort_order = COALESCE(?, sort_order),
            config     = COALESCE(?, config)
        WHERE id = ?
    `).run(
        content !== undefined ? (typeof content === 'string' ? content : JSON.stringify(content)) : null,
        media_url ?? null,
        sort_order ?? null,
        config !== undefined ? JSON.stringify(config) : null,
        req.params.id
    );

    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    row.content = parseJsonField(row.content, {});
    row.config = parseJsonField(row.config, {});
    res.json(row);
});

router.delete('/questions/:id', (req, res) => {
    const info = db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'no encontrada' });
    res.status(204).end();
});

// Reordenar preguntas dentro de una ronda.
router.put('/rounds/:id/questions/reorder', (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order debe ser un array de IDs' });
    const update = db.prepare('UPDATE questions SET sort_order = ? WHERE id = ? AND round_id = ?');
    db.transaction(() => {
        order.forEach((id, idx) => update.run(idx, id, req.params.id));
    })();
    const qs = db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sort_order, id').all(req.params.id);
    for (const q of qs) { q.content = parseJsonField(q.content, {}); q.config = parseJsonField(q.config, {}); }
    res.json(qs);
});

module.exports = router;
