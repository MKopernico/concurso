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

// ───────────────── EXCEL IMPORT ─────────────────

const multer = require('multer');
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Sheet name → round type mapping
const SHEET_TYPE_MAP = {
    '50x15 — Multirespuesta': 'multirespuesta',
    'Pulsador — Rápido': 'pulsador',
    'Precio Justo': 'precio',
    'Boom — Ordenar': 'boom',
    'Ruleta — La Suerte': 'ruleta',
    'Imagen Fija': 'imagen_fija',
};

function parseExcelSheet(rows, type) {
    // rows: array of arrays, data starts at row index 3 (row 4 in Excel, 0-indexed)
    const questions = []; // grouped by round name
    const rounds = {}; // roundName → { questions: [], config from first row }

    for (let i = 3; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.every(c => c === '' || c === undefined || c === null)) continue;

        const roundName = String(r[0] || '').trim();
        if (!roundName) continue;

        if (!rounds[roundName]) rounds[roundName] = { questions: [], config: {} };

        let content, qConfig = {};

        switch (type) {
            case 'multirespuesta': {
                const statement = String(r[1] || '').trim();
                if (!statement) continue;
                const options = [r[2], r[3], r[4], r[5], r[6]].map(o => String(o || '').trim()).filter(Boolean);
                if (options.length < 2) continue;
                const correctStr = String(r[7] || '');
                const correct = correctStr.split(/[,;]/).map(s => Number(s.trim()) - 1).filter(n => n >= 0 && n < options.length);
                if (correct.length === 0) continue;
                content = { statement, options, correct, explanation: String(r[8] || '').trim() || undefined };
                if (r[9]) qConfig.time = Number(r[9]) || undefined;
                if (r[10]) qConfig.basePoints = Number(r[10]) || undefined;
                if (r[11]) qConfig.bonusMax = Number(r[11]) || undefined;
                if (r[12]) qConfig.penalty = Number(r[12]) || undefined;
                if (String(r[13] || '').trim()) rounds[roundName].config.background = String(r[13]).trim();
                break;
            }
            case 'pulsador': {
                const statement = String(r[1] || '').trim();
                const answer = String(r[2] || '').trim();
                if (!statement || !answer) continue;
                const hints = [r[3], r[4]].map(h => String(h || '').trim()).filter(Boolean);
                content = { statement, answer, hints: hints.length ? hints : undefined };
                if (r[5]) qConfig.time = Number(r[5]) || undefined;
                if (r[6]) qConfig.basePoints = Number(r[6]) || undefined;
                if (r[7]) qConfig.penalty = Number(r[7]) || undefined;
                if (String(r[8] || '').trim()) rounds[roundName].config.background = String(r[8]).trim();
                break;
            }
            case 'precio': {
                const statement = String(r[1] || '').trim();
                const correctVal = Number(r[2]);
                if (!statement || !isFinite(correctVal)) continue;
                content = { statement, correct_value: correctVal, image: String(r[3] || '').trim() || undefined };
                if (r[4]) qConfig.time = Number(r[4]) || undefined;
                if (r[5]) qConfig.basePoints = Number(r[5]) || undefined;
                if (String(r[6] || '').trim()) rounds[roundName].config.background = String(r[6]).trim();
                break;
            }
            case 'boom': {
                const statement = String(r[1] || '').trim();
                if (!statement) continue;
                const items = [r[2], r[3], r[4], r[5], r[6]].map(v => String(v || '').trim()).filter(Boolean);
                if (items.length < 2) continue;
                const orderStr = String(r[7] || '');
                const correct_order = orderStr.split(/[,;]/).map(s => Number(s.trim()) - 1).filter(n => n >= 0);
                if (correct_order.length === 0) continue;
                content = { statement, items, correct_order };
                if (r[8]) qConfig.time = Number(r[8]) || undefined;
                if (r[9]) qConfig.basePoints = Number(r[9]) || undefined;
                if (r[10]) qConfig.bonusMax = Number(r[10]) || undefined;
                if (String(r[11] || '').trim()) rounds[roundName].config.background = String(r[11]).trim();
                break;
            }
            case 'ruleta': {
                const phrase = String(r[1] || '').trim();
                if (!phrase) continue;
                const groups = [r[2], r[3], r[4], r[5], r[6]].map(g => {
                    if (!g || String(g).trim() === '') return null;
                    // Each group is comma-separated letter indices or letters
                    const chars = String(g).split(',').map(s => s.trim()).filter(Boolean);
                    // Convert letters to their positions in the phrase (ignoring spaces)
                    const positions = [];
                    for (const ch of chars) {
                        const upperCh = ch.toUpperCase();
                        // Find ALL positions of this letter in the phrase
                        for (let p = 0; p < phrase.length; p++) {
                            if (phrase[p] === ' ') continue;
                            if (phrase[p].toUpperCase() === upperCh && !positions.includes(p)) {
                                // Only add if not already added by a previous group
                                positions.push(p);
                                break; // one per letter entry
                            }
                        }
                    }
                    return positions.length ? positions : null;
                }).filter(Boolean);
                if (groups.length === 0) continue;
                content = { phrase, reveal_groups: groups };
                if (r[7]) qConfig.basePoints = Number(r[7]) || undefined;
                if (r[8]) qConfig.bonusMax = Number(r[8]) || undefined;
                if (String(r[9] || '').trim()) rounds[roundName].config.background = String(r[9]).trim();
                break;
            }
            case 'imagen_fija': {
                const image = String(r[2] || '').trim();
                if (!image) continue;
                const buzzerVal = String(r[4] || '').trim().toLowerCase();
                content = {
                    image,
                    statement: String(r[1] || '').trim() || undefined,
                    answer: String(r[3] || '').trim() || undefined,
                    buzzer_enabled: buzzerVal !== 'no',
                };
                if (r[5]) qConfig.time = Number(r[5]) || undefined;
                if (r[6]) qConfig.basePoints = Number(r[6]) || undefined;
                if (String(r[7] || '').trim()) rounds[roundName].config.background = String(r[7]).trim();
                break;
            }
            default: continue;
        }

        // Clean empty config
        Object.keys(qConfig).forEach(k => { if (qConfig[k] === undefined) delete qConfig[k]; });

        rounds[roundName].questions.push({ content, config: Object.keys(qConfig).length ? qConfig : undefined });
    }

    return rounds;
}

// Import from Excel: creates rounds + questions for a game
router.post('/games/:id/import-excel', xlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const game = db.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });

    let XLSX;
    try { XLSX = require('xlsx'); } catch { return res.status(500).json({ error: 'Módulo xlsx no instalado' }); }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    const results = { rounds: 0, questions: 0, errors: [] };

    // Get max sort_order for existing rounds
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rounds WHERE game_id = ?').get(req.params.id);
    let roundSortOrder = (maxSort ? maxSort.m : -1) + 1;

    const insertRound = db.prepare('INSERT INTO rounds (id, game_id, name, type, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    const insertQuestion = db.prepare('INSERT INTO questions (id, round_id, content, config, sort_order) VALUES (?, ?, ?, ?, ?)');

    db.transaction(() => {
        for (const sheetName of wb.SheetNames) {
            const type = SHEET_TYPE_MAP[sheetName];
            if (!type) continue;

            const ws = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            const roundsData = parseExcelSheet(rows, type);

            for (const [roundName, roundData] of Object.entries(roundsData)) {
                if (roundData.questions.length === 0) continue;

                // Build round config from first question's shared config
                const roundConfig = { time: 30, basePoints: 100, bonusMax: 50, penalty: 0 };
                const firstQ = roundData.questions[0];
                if (firstQ.config) {
                    if (firstQ.config.time) roundConfig.time = firstQ.config.time;
                    if (firstQ.config.basePoints) roundConfig.basePoints = firstQ.config.basePoints;
                    if (firstQ.config.bonusMax) roundConfig.bonusMax = firstQ.config.bonusMax;
                    if (firstQ.config.penalty) roundConfig.penalty = firstQ.config.penalty;
                }
                if (roundData.config.background) roundConfig.background = roundData.config.background;

                const roundId = newId('r');
                insertRound.run(roundId, req.params.id, roundName, type, JSON.stringify(roundConfig), roundSortOrder++);
                results.rounds++;

                roundData.questions.forEach((q, qIdx) => {
                    const qId = newId('q');
                    insertQuestion.run(qId, roundId, JSON.stringify(q.content), q.config ? JSON.stringify(q.config) : null, qIdx);
                    results.questions++;
                });
            }
        }
    })();

    res.json(results);
});

// ───────────────── SESSIONS ─────────────────

// Start a live session for a published game
router.post('/games/:id/session', (req, res) => {
    const game = db.prepare('SELECT id, status FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });
    if (game.status !== 'published') return res.status(400).json({ error: 'el juego debe estar publicado' });

    // Close any existing open session for this game
    db.prepare('UPDATE sessions SET ended_at = datetime(\'now\') WHERE game_id = ? AND ended_at IS NULL').run(req.params.id);

    const sessionId = newId('s');
    db.prepare('INSERT INTO sessions (id, game_id) VALUES (?, ?)').run(sessionId, req.params.id);
    res.status(201).json({ sessionId, gameId: req.params.id });
});

// Stop the active session
router.delete('/games/:id/session', (req, res) => {
    const info = db.prepare('UPDATE sessions SET ended_at = datetime(\'now\') WHERE game_id = ? AND ended_at IS NULL').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'no hay sesión activa' });
    res.json({ ok: true });
});

// Get active session for a game (if any)
router.get('/games/:id/session', (req, res) => {
    const session = db.prepare('SELECT * FROM sessions WHERE game_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'no hay sesión activa' });
    const teams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
    res.json({ ...session, teams });
});

// List published games with active sessions (for /play)
router.get('/active-games', (req, res) => {
    const rows = db.prepare(`
        SELECT g.id, g.name, g.date, g.theme, g.access_code, s.id as session_id, s.started_at
        FROM games g
        JOIN sessions s ON s.game_id = g.id AND s.ended_at IS NULL
        WHERE g.status = 'published'
        ORDER BY s.started_at DESC
    `).all();
    rows.forEach(r => { r.theme = parseJsonField(r.theme, null); });
    res.json(rows);
});

// Create a team in the active session (player self-registration)
router.post('/games/:id/teams', (req, res) => {
    const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(req.params.id);
    if (!session) return res.status(400).json({ error: 'no hay sesión activa' });

    const { name, photo_url, device_id } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });

    // Check if this device already has a team in this session
    if (device_id) {
        const existing = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, device_id);
        if (existing) return res.json(existing);
    }

    const teamId = newId('t');
    db.prepare('INSERT INTO teams (id, session_id, name, photo_url, device_id) VALUES (?, ?, ?, ?, ?)')
        .run(teamId, session.id, name.trim(), photo_url || null, device_id || null);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    res.status(201).json(team);
});

// Update a team (name, photo)
router.put('/teams/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'equipo no encontrado' });
    const { name, photo_url } = req.body || {};
    db.prepare('UPDATE teams SET name = COALESCE(?, name), photo_url = COALESCE(?, photo_url) WHERE id = ?')
        .run(name ?? null, photo_url !== undefined ? photo_url : null, req.params.id);
    res.json(db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id));
});

// Get team by device_id for reconnection
router.get('/games/:id/team-by-device/:deviceId', (req, res) => {
    const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'no session' });
    const team = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, req.params.deviceId);
    if (!team) return res.status(404).json({ error: 'no team' });
    res.json(team);
});

module.exports = router;
