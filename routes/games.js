// CRUD de juegos + rondas + preguntas (spec §10.3).
// Diseño: una sola "router factory" para que server.js sólo monte /api -> require('./routes/games').

const express = require('express');
const crypto = require('crypto');
const { db, DEFAULT_GAME_ID } = require('../db');

const QuestionValidation = require('../public/shared/question-validation.js');

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

    if (status === 'published') {
        const game = loadGameTree(req.params.id);
        const incompleteList = [];
        for (const round of (game.rounds || [])) {
            for (const q of (round.questions || [])) {
                const content = typeof q.content === 'string' ? parseJsonField(q.content, {}) : (q.content || {});
                const v = QuestionValidation.isComplete(round.type, content);
                if (!v.complete) {
                    incompleteList.push({ round: round.name, question: q.sort_order + 1, type: round.type, missing: v.missing });
                }
            }
        }
        if (incompleteList.length > 0) {
            return res.status(400).json({ error: 'incomplete_questions', incomplete: incompleteList });
        }
    }

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

// ───────────────── EXPORT EXCEL ─────────────────

function contentToRow(typeDef, roundName, question) {
    const c = question.content || {};
    const qCfg = question.config || {};

    switch (typeDef.type) {
        case 'multirespuesta': {
            const opts = c.options || [];
            const rawCorrect = Array.isArray(c.correct) ? c.correct : (c.correct !== undefined ? [c.correct] : []);
            const correct = rawCorrect.map(i => i + 1).join(',');
            return [roundName, c.statement || '', opts[0] || '', opts[1] || '', opts[2] || '', opts[3] || '', opts[4] || '', correct, c.explanation || '', qCfg.time || '', qCfg.basePoints || '', qCfg.bonusMax || '', qCfg.penalty || ''];
        }
        case 'pulsador': {
            const hints = c.hints || [];
            return [roundName, c.statement || '', c.answer || '', hints[0] || '', hints[1] || '', qCfg.time || '', qCfg.basePoints || '', qCfg.penalty || ''];
        }
        case 'precio':
            return [roundName, c.statement || '', c.correct_value ?? '', c.image || '', qCfg.time || '', qCfg.basePoints || ''];
        case 'boom': {
            const items = c.items || [];
            const rawOrder = Array.isArray(c.correct_order) ? c.correct_order : (c.correct_order !== undefined ? [c.correct_order] : []);
            const order = rawOrder.map(i => i + 1).join(',');
            return [roundName, c.statement || '', items[0] || '', items[1] || '', items[2] || '', items[3] || '', items[4] || '', order, qCfg.time || '', qCfg.basePoints || '', qCfg.bonusMax || ''];
        }
        case 'ruleta':
            return [roundName, c.hint || '', c.phrase || '', qCfg.basePoints || '', qCfg.bonusMax || ''];
        case 'imagen':
            return [roundName, c.statement || '', c.answer || '', c.image || '', qCfg.basePoints || ''];
        case 'imagen_fija': {
            const hasVideo = !!c.video;
            return [roundName, c.statement || '', hasVideo ? '' : (c.image || ''), hasVideo ? c.video : '', c.answer || '', c.buzzer_enabled === false ? 'no' : 'si', hasVideo ? (c.autoplay === false ? 'no' : 'si') : '', hasVideo ? (c.loop ? 'si' : 'no') : '', qCfg.time || '', qCfg.basePoints || ''];
        }
        case 'cancion':
            return [roundName, c.statement || '', c.answer || '', c.image || '', c.audio || '', c.initial_chaos ?? 100, c.preset || 'default', qCfg.basePoints || ''];
        case 'identidad': {
            const pairs = Array.isArray(c.pairs) ? c.pairs : [];
            if (pairs.length === 0) return [[roundName, c.statement || '', '', '', '', '', c.explanation || '', qCfg.basePoints || '', qCfg.time || '']];
            return pairs.map((p, idx) => {
                const l = p.left || {}, r = p.right || {};
                if (idx === 0) return [roundName, c.statement || '', l.image || '', l.text || '', r.image || '', r.text || '', c.explanation || '', qCfg.basePoints || '', qCfg.time || ''];
                return [roundName, '', l.image || '', l.text || '', r.image || '', r.text || '', '', '', ''];
            });
        }
        default:
            return [roundName];
    }
}

// ── Shared instruction rows for template & export ──
const ALL_TYPES = ['multirespuesta', 'pulsador', 'precio', 'boom', 'ruleta', 'imagen', 'imagen_fija', 'cancion', 'identidad'];

function buildInstructionRows() {
    const rows = [
        ['INSTRUCCIONES — Plantilla de importación GameShow'],
        [],
        ['ESTRUCTURA DEL FICHERO:'],
        ['  - Hoja "Configuración" (opcional): tema del juego (logo, colores, fondos, logos/fondos por tipo).'],
        ['    Si se incluye, REEMPLAZA el tema del juego destino al importar.'],
        ['  - Hoja "Rondas" (opcional pero recomendada): define rondas con tipo, config, logo y fondo.'],
        ['    Columnas: nombre, tipo, tiempo, puntos_base, bonus_max, penalizacion, logo, fondo.'],
        ['    Si no se incluye, las rondas se crean automáticamente desde las pestañas de preguntas.'],
        ['  - Pestañas de prueba: una por tipo. La columna "ronda" referencia la ronda por nombre.'],
        [],
        ['REGLAS GENERALES:'],
        ['1. La columna "ronda" es OBLIGATORIA en cada pestaña: cada nombre único crea una ronda nueva.'],
        ['2. Reimportar el mismo fichero DUPLICA las rondas (no machaca las existentes).'],
        ['3. Las columnas de media (imagen, audio, video) esperan la ruta del archivo'],
        ['   ya subido en el servidor (ej: /uploads/images/foto.jpg).'],
        ['   Suba los archivos desde el admin ANTES de importar el Excel.'],
        ['4. Los campos de configuración (tiempo, puntos_base, etc.) son opcionales.'],
        ['   Si se omiten, se usan los valores por defecto.'],
        ['5. Las filas sin datos obligatorios (ej: imagen sin respuesta) se omiten silenciosamente.'],
        [],
        ['HOJA "CONFIGURACIÓN" — campos (col A) y valores (col B):'],
        ['  logo — URL del logo del juego (ej: /uploads/images/logo.png)'],
        ['  color_primario — color hex (ej: #00d4ff)'],
        ['  color_secundario — color hex (ej: #fbbf24)'],
        ['  fondo_tipo — none, color, gradient o image'],
        ['  fondo_color — color hex (si fondo_tipo=color)'],
        ['  fondo_gradiente — preset (nightSky, ocean, etc.) o CSS custom (si fondo_tipo=gradient)'],
        ['  fondo_imagen — URL de imagen (si fondo_tipo=image)'],
        ['  fondo_aplicar_a_todo — si/no: aplica el fondo global a todas las pruebas'],
        ['  fondo_home — URL de imagen de fondo del Home'],
        ['  tipo_{tipo}_logo — logo por tipo de prueba (ej: tipo_pulsador_logo)'],
        ['  tipo_{tipo}_fondo — fondo por tipo de prueba (ej: tipo_pulsador_fondo)'],
        [],
        ['TIPOS DE PRUEBA:'],
    ];
    EXCEL_TYPE_DEFS.forEach(d => {
        rows.push(['  - ' + d.sheet + ' (' + d.type + ')']);
    });
    rows.push([], ['NOTAS POR TIPO:']);
    rows.push(['  Multirespuesta: "correctas" = números de opción separados por coma (ej: 1,3). Opciones 4 y 5 son opcionales.']);
    rows.push(['  Pulsador: pistas son opcionales.']);
    rows.push(['  Boom: "orden_correcto" = orden de los elementos separado por coma (ej: 3,1,2,4).']);
    rows.push(['  Ruleta: "pista" es la categoría/pista mostrada al público. "frase" se revela letra a letra.']);
    rows.push(['  Imagen: solo enunciado + respuesta + ruta imagen. La cuadrícula se ajusta en el admin.']);
    rows.push(['  Imagen Fija: usar columna "imagen" O "video" (no ambas). "pulsador": "no" para desactivar.']);
    rows.push(['    "autoplay" y "loop": "si"/"no" (solo aplican con vídeo).']);
    rows.push(['  Cancion: caos_inicial (0-100, defecto 100), preset (defecto "default").']);
    rows.push(['  Identidad: una fila por pareja. La 1ª fila lleva enunciado, explicación y config; las siguientes dejan enunciado vacío.']);
    rows.push(['    Cada lado (izq/der) necesita imagen O texto (o ambos). Las imágenes son rutas ya subidas.']);
    return rows;
}

// ── Theme ↔ Config sheet helpers ──

function themeToConfigRows(theme) {
    if (!theme) return [];
    const rows = [];
    const add = (field, val) => { if (val !== undefined && val !== null && val !== '') rows.push([field, val]); };
    add('logo', theme.logo);
    add('color_primario', theme.primaryColor);
    add('color_secundario', theme.secondaryColor);
    add('fondo_tipo', theme.backgroundType);
    add('fondo_color', theme.backgroundColor);
    add('fondo_gradiente', theme.backgroundGradient);
    add('fondo_imagen', theme.backgroundImage);
    add('fondo_aplicar_a_todo', theme.backgroundApplyToAll ? 'si' : 'no');
    add('fondo_home', theme.homeBackground);
    if (theme.types) {
        for (const t of ALL_TYPES) {
            const td = theme.types[t];
            if (!td) continue;
            add('tipo_' + t + '_logo', td.logo);
            add('tipo_' + t + '_fondo', td.background);
        }
    }
    return rows;
}

function configRowsToTheme(rows) {
    const map = {};
    for (const row of rows) {
        const field = String(row[0] || '').trim();
        const val = String(row[1] || '').trim();
        if (field && val) map[field] = val;
    }
    const theme = {};
    if (map.logo) theme.logo = map.logo;
    if (map.color_primario) theme.primaryColor = map.color_primario;
    if (map.color_secundario) theme.secondaryColor = map.color_secundario;
    if (map.fondo_tipo && map.fondo_tipo !== 'none') {
        theme.backgroundType = map.fondo_tipo;
        if (map.fondo_tipo === 'color' && map.fondo_color) theme.backgroundColor = map.fondo_color;
        if (map.fondo_tipo === 'gradient' && map.fondo_gradiente) theme.backgroundGradient = map.fondo_gradiente;
        if (map.fondo_tipo === 'image' && map.fondo_imagen) theme.backgroundImage = map.fondo_imagen;
    }
    if (map.fondo_aplicar_a_todo === 'si') theme.backgroundApplyToAll = true;
    if (map.fondo_home) theme.homeBackground = map.fondo_home;
    const types = {};
    for (const t of ALL_TYPES) {
        const logo = map['tipo_' + t + '_logo'];
        const bg = map['tipo_' + t + '_fondo'];
        if (logo || bg) {
            types[t] = {};
            if (logo) types[t].logo = logo;
            if (bg) types[t].background = bg;
        }
    }
    if (Object.keys(types).length) theme.types = types;
    return Object.keys(theme).length ? theme : null;
}

router.get('/games/:id/export-excel', (req, res) => {
    let XLSX;
    try { XLSX = require('xlsx'); } catch { return res.status(500).json({ error: 'Módulo xlsx no instalado' }); }

    const game = loadGameTree(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });

    const wb = XLSX.utils.book_new();

    // Sheet 1: Instructions
    const wsInstr = XLSX.utils.aoa_to_sheet(buildInstructionRows());
    wsInstr['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsInstr, 'Instrucciones');

    // Sheet 2: Configuration (game theme)
    const configRows = themeToConfigRows(game.theme);
    const wsConfig = XLSX.utils.aoa_to_sheet([
        ['Configuración del juego'],
        [],
        ['campo', 'valor'],
        ...configRows,
    ]);
    wsConfig['!cols'] = [{ wch: 30 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsConfig, 'Configuración');

    // Sheet 3: Rounds
    const ROUND_COLUMNS = ['nombre', 'tipo', 'tiempo', 'puntos_base', 'bonus_max', 'penalizacion', 'logo', 'fondo'];
    const roundRows = game.rounds.map(r => {
        const cfg = r.config || {};
        return [r.name, r.type, cfg.time ?? '', cfg.basePoints ?? '', cfg.bonusMax ?? '', cfg.penalty ?? '', cfg.logo || '', cfg.background || ''];
    });
    const wsRondas = XLSX.utils.aoa_to_sheet([
        ['Rondas'],
        [],
        ROUND_COLUMNS,
        ...roundRows,
    ]);
    wsRondas['!cols'] = ROUND_COLUMNS.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, wsRondas, 'Rondas');

    // Sheets 4+: one per type with question data
    const byType = {};
    for (const round of game.rounds) {
        if (!byType[round.type]) byType[round.type] = [];
        byType[round.type].push(round);
    }

    EXCEL_TYPE_DEFS.forEach(d => {
        const dataRows = [];
        const rounds = byType[d.type] || [];
        for (const round of rounds) {
            for (const q of (round.questions || [])) {
                const row = contentToRow(d, round.name, q);
                if (Array.isArray(row[0])) dataRows.push(...row); else dataRows.push(row);
            }
        }
        const wsData = XLSX.utils.aoa_to_sheet([
            [d.sheet + ' (' + d.type + ')'],
            [],
            d.columns,
            ...dataRows,
        ]);
        wsData['!cols'] = d.columns.map(() => ({ wch: 18 }));
        XLSX.utils.book_append_sheet(wb, wsData, d.sheet);
    });

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (game.name || 'juego').replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _-]/g, '').trim() || 'juego';
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
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

// Canonical type definitions: sheet name, type key, and columns.
// Single source of truth for importer (SHEET_TYPE_MAP + parseExcelSheet) AND template generator.
const EXCEL_TYPE_DEFS = [
    { sheet: 'Multirespuesta', type: 'multirespuesta', columns: ['ronda', 'enunciado', 'opcion_1', 'opcion_2', 'opcion_3', 'opcion_4', 'opcion_5', 'correctas', 'explicacion', 'tiempo', 'puntos_base', 'bonus_max', 'penalizacion'] },
    { sheet: 'Pulsador',       type: 'pulsador',       columns: ['ronda', 'enunciado', 'respuesta', 'pista_1', 'pista_2', 'tiempo', 'puntos_base', 'penalizacion'] },
    { sheet: 'Precio Justo',   type: 'precio',         columns: ['ronda', 'enunciado', 'valor_correcto', 'imagen', 'tiempo', 'puntos_base'] },
    { sheet: 'Boom',           type: 'boom',            columns: ['ronda', 'enunciado', 'elemento_1', 'elemento_2', 'elemento_3', 'elemento_4', 'elemento_5', 'orden_correcto', 'tiempo', 'puntos_base', 'bonus_max'] },
    { sheet: 'Ruleta',         type: 'ruleta',          columns: ['ronda', 'pista', 'frase', 'puntos_base', 'bonus_max'] },
    { sheet: 'Imagen',         type: 'imagen',          columns: ['ronda', 'enunciado', 'respuesta', 'imagen', 'puntos_base'] },
    { sheet: 'Imagen Fija',    type: 'imagen_fija',     columns: ['ronda', 'enunciado', 'imagen', 'video', 'respuesta', 'pulsador', 'autoplay', 'loop', 'tiempo', 'puntos_base'] },
    { sheet: 'Cancion',        type: 'cancion',         columns: ['ronda', 'enunciado', 'respuesta', 'imagen', 'audio', 'caos_inicial', 'preset', 'puntos_base'] },
    { sheet: 'Identidad',      type: 'identidad',       columns: ['ronda', 'enunciado', 'izq_imagen', 'izq_texto', 'der_imagen', 'der_texto', 'explicacion', 'puntos_base', 'tiempo'] },
];

const SHEET_TYPE_MAP = {};
EXCEL_TYPE_DEFS.forEach(d => { SHEET_TYPE_MAP[d.sheet] = d.type; });

function parseIdentidadSheet(rows) {
    const rounds = {};
    let skipped = 0;
    const incomplete = [];
    let currentQuestion = null;
    let currentRound = null;

    function flushQuestion() {
        if (!currentQuestion || !currentRound) return;
        const validation = QuestionValidation.isComplete('identidad', currentQuestion.content);
        if (!validation.complete) {
            incomplete.push({ row: currentQuestion.startRow, round: currentRound, missing: validation.missing });
        }
        const qConfig = currentQuestion.config;
        Object.keys(qConfig).forEach(k => { if (qConfig[k] === undefined) delete qConfig[k]; });
        rounds[currentRound].questions.push({ content: currentQuestion.content, config: Object.keys(qConfig).length ? qConfig : undefined });
        currentQuestion = null;
    }

    for (let i = 3; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.every(c => c === '' || c === undefined || c === null)) continue;

        const roundName = String(r[0] || '').trim();
        if (!roundName) continue;

        if (!rounds[roundName]) rounds[roundName] = { questions: [], config: {} };

        const enunciado = String(r[1] || '').trim();
        const lImg = String(r[2] || '').trim() || undefined;
        const lTxt = String(r[3] || '').trim() || undefined;
        const rImg = String(r[4] || '').trim() || undefined;
        const rTxt = String(r[5] || '').trim() || undefined;

        if (enunciado) {
            flushQuestion();
            currentRound = roundName;
            const qConfig = {};
            if (r[7]) qConfig.basePoints = Number(r[7]) || undefined;
            if (r[8]) qConfig.time = Number(r[8]) || undefined;
            currentQuestion = {
                startRow: i + 1,
                content: { statement: enunciado, pairs: [], explanation: String(r[6] || '').trim() || undefined },
                config: qConfig,
            };
        }

        if (!currentQuestion) { skipped++; continue; }

        if (!lImg && !lTxt && !rImg && !rTxt) { skipped++; continue; }

        currentQuestion.content.pairs.push({ left: { image: lImg, text: lTxt }, right: { image: rImg, text: rTxt } });
    }
    flushQuestion();

    return { rounds, skipped, incomplete };
}

function parseExcelSheet(rows, type) {
    if (type === 'identidad') return parseIdentidadSheet(rows);

    // rows: array of arrays, data starts at row index 3 (row 4 in Excel, 0-indexed)
    const rounds = {}; // roundName → { questions: [], config from first row }
    let skipped = 0;
    const incomplete = []; // { row, round, missing: [] }

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
                const options = [r[2], r[3], r[4], r[5], r[6]].map(o => String(o || '').trim()).filter(Boolean);
                const correctStr = String(r[7] || '');
                const correct = correctStr ? correctStr.split(/[,;]/).map(s => Number(s.trim()) - 1).filter(n => n >= 0 && n < options.length) : [];
                if (!statement && options.length === 0) break; // truly empty
                content = { statement: statement || undefined, options, correct, explanation: String(r[8] || '').trim() || undefined };
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
                const hints = [r[3], r[4]].map(h => String(h || '').trim()).filter(Boolean);
                if (!statement && !answer && hints.length === 0) break;
                content = { statement: statement || undefined, answer: answer || undefined, hints: hints.length ? hints : undefined };
                if (r[5]) qConfig.time = Number(r[5]) || undefined;
                if (r[6]) qConfig.basePoints = Number(r[6]) || undefined;
                if (r[7]) qConfig.penalty = Number(r[7]) || undefined;
                if (String(r[8] || '').trim()) rounds[roundName].config.background = String(r[8]).trim();
                break;
            }
            case 'precio': {
                const statement = String(r[1] || '').trim();
                const correctVal = Number(r[2]);
                if (!statement && !isFinite(correctVal)) break;
                content = { statement: statement || undefined, correct_value: isFinite(correctVal) ? correctVal : undefined, image: String(r[3] || '').trim() || undefined };
                if (r[4]) qConfig.time = Number(r[4]) || undefined;
                if (r[5]) qConfig.basePoints = Number(r[5]) || undefined;
                if (String(r[6] || '').trim()) rounds[roundName].config.background = String(r[6]).trim();
                break;
            }
            case 'boom': {
                const statement = String(r[1] || '').trim();
                const items = [r[2], r[3], r[4], r[5], r[6]].map(v => String(v || '').trim()).filter(Boolean);
                const orderStr = String(r[7] || '');
                const correct_order = orderStr ? orderStr.split(/[,;]/).map(s => Number(s.trim()) - 1).filter(n => n >= 0) : [];
                if (!statement && items.length === 0) break;
                content = { statement: statement || undefined, items, correct_order };
                if (r[8]) qConfig.time = Number(r[8]) || undefined;
                if (r[9]) qConfig.basePoints = Number(r[9]) || undefined;
                if (r[10]) qConfig.bonusMax = Number(r[10]) || undefined;
                if (String(r[11] || '').trim()) rounds[roundName].config.background = String(r[11]).trim();
                break;
            }
            case 'ruleta': {
                const hint = String(r[1] || '').trim();
                const phrase = String(r[2] || '').trim();
                if (!phrase && !hint) break;
                content = { hint: hint || undefined, phrase: phrase || undefined };
                if (r[3]) qConfig.basePoints = Number(r[3]) || undefined;
                if (r[4]) qConfig.bonusMax = Number(r[4]) || undefined;
                if (String(r[5] || '').trim()) rounds[roundName].config.background = String(r[5]).trim();
                break;
            }
            case 'imagen_fija': {
                const image = String(r[2] || '').trim();
                const video = String(r[3] || '').trim();
                const statement = String(r[1] || '').trim();
                const answer = String(r[4] || '').trim();
                if (!image && !video && !statement && !answer) break;
                const buzzerVal = String(r[5] || '').trim().toLowerCase();
                content = {
                    statement: statement || undefined,
                    answer: answer || undefined,
                    buzzer_enabled: buzzerVal !== 'no',
                };
                if (video) {
                    content.video = video;
                    const apVal = String(r[6] || '').trim().toLowerCase();
                    const loopVal = String(r[7] || '').trim().toLowerCase();
                    content.autoplay = apVal !== 'no';
                    content.loop = loopVal === 'si' || loopVal === 'sí' || loopVal === 'yes';
                } else if (image) {
                    content.image = image;
                }
                if (r[8]) qConfig.time = Number(r[8]) || undefined;
                if (r[9]) qConfig.basePoints = Number(r[9]) || undefined;
                if (String(r[10] || '').trim()) rounds[roundName].config.background = String(r[10]).trim();
                break;
            }
            case 'imagen': {
                const statement = String(r[1] || '').trim();
                const answer = String(r[2] || '').trim();
                if (!statement && !answer) break;
                content = {
                    statement: statement || undefined,
                    answer: answer || undefined,
                    image: String(r[3] || '').trim() || undefined,
                };
                if (r[4]) qConfig.basePoints = Number(r[4]) || undefined;
                if (String(r[5] || '').trim()) rounds[roundName].config.background = String(r[5]).trim();
                break;
            }
            case 'cancion': {
                const statement = String(r[1] || '').trim();
                const answer = String(r[2] || '').trim();
                if (!statement && !answer) break;
                content = {
                    statement: statement || undefined,
                    answer: answer || undefined,
                    image: String(r[3] || '').trim() || undefined,
                    audio: String(r[4] || '').trim() || undefined,
                    initial_chaos: Number(r[5]) || 100,
                    preset: String(r[6] || '').trim() || 'default',
                };
                if (r[7]) qConfig.basePoints = Number(r[7]) || undefined;
                if (String(r[8] || '').trim()) rounds[roundName].config.background = String(r[8]).trim();
                break;
            }
            default: break;
        }

        if (!content) { skipped++; continue; }

        const validation = QuestionValidation.isComplete(type, content);
        if (!validation.complete) {
            incomplete.push({ row: i + 1, round: roundName, missing: validation.missing });
        }

        // Clean empty config
        Object.keys(qConfig).forEach(k => { if (qConfig[k] === undefined) delete qConfig[k]; });

        rounds[roundName].questions.push({ content, config: Object.keys(qConfig).length ? qConfig : undefined });
    }

    return { rounds, skipped, incomplete };
}

// Import from Excel: creates rounds + questions for a game
router.post('/games/:id/import-excel', xlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const game = db.prepare('SELECT id FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'juego no encontrado' });

    let XLSX;
    try { XLSX = require('xlsx'); } catch { return res.status(500).json({ error: 'Módulo xlsx no instalado' }); }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    console.log('[Excel Import] Hojas encontradas:', wb.SheetNames);
    console.log('[Excel Import] Hojas reconocidas:', wb.SheetNames.filter(s => SHEET_TYPE_MAP[s] || s === 'Rondas').map(s => s));
    console.log('[Excel Import] Hojas ignoradas:', wb.SheetNames.filter(s => !SHEET_TYPE_MAP[s] && s !== 'Rondas' && s !== 'Instrucciones' && s !== 'Configuración'));

    const results = { rounds: 0, questions: 0, skipped: 0, errors: [], incomplete: [] };

    // ── Read "Configuración" sheet if present → replace game theme ──
    if (wb.SheetNames.includes('Configuración')) {
        const wsC = wb.Sheets['Configuración'];
        const cRows = XLSX.utils.sheet_to_json(wsC, { header: 1, defval: '' });
        const dataRows = cRows.slice(3); // skip title, empty, headers
        const theme = configRowsToTheme(dataRows);
        db.prepare('UPDATE games SET theme = ? WHERE id = ?').run(theme ? JSON.stringify(theme) : null, req.params.id);
        console.log('[Excel Import] Hoja Configuración: tema actualizado');
    }

    // ── Read "Rondas" sheet if present (new format) ──
    const roundDefs = {}; // roundName → { type, config }
    const hasRoundsSheet = wb.SheetNames.includes('Rondas');
    if (hasRoundsSheet) {
        const wsR = wb.Sheets['Rondas'];
        const rRows = XLSX.utils.sheet_to_json(wsR, { header: 1, defval: '' });
        for (let i = 3; i < rRows.length; i++) {
            const row = rRows[i];
            if (!row || row.every(c => c === '' || c === undefined || c === null)) continue;
            const name = String(row[0] || '').trim();
            if (!name) continue;
            const type = String(row[1] || '').trim();
            if (!type) continue;
            const cfg = {};
            if (row[2] !== '' && row[2] !== undefined) cfg.time = Number(row[2]) || 0;
            if (row[3] !== '' && row[3] !== undefined) cfg.basePoints = Number(row[3]) || 100;
            if (row[4] !== '' && row[4] !== undefined) cfg.bonusMax = Number(row[4]) || 50;
            if (row[5] !== '' && row[5] !== undefined) cfg.penalty = Number(row[5]) || 0;
            const logo = String(row[6] || '').trim();
            if (logo) cfg.logo = logo;
            const bg = String(row[7] || '').trim();
            if (bg) cfg.background = bg;
            roundDefs[name] = { type, config: cfg };
        }
        console.log('[Excel Import] Hoja Rondas: ' + Object.keys(roundDefs).length + ' rondas definidas');
    }

    // Get max sort_order for existing rounds
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rounds WHERE game_id = ?').get(req.params.id);
    let roundSortOrder = (maxSort ? maxSort.m : -1) + 1;

    const insertRound = db.prepare('INSERT INTO rounds (id, game_id, name, type, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    const insertQuestion = db.prepare('INSERT INTO questions (id, round_id, content, config, sort_order) VALUES (?, ?, ?, ?, ?)');

    // Track which round names from the Rondas sheet got questions (to create empty ones later)
    const roundsWithQuestions = new Set();
    // Track created round IDs by name+type to reuse within this import
    const createdRounds = {}; // `${name}__${type}` → roundId

    db.transaction(() => {
        for (const sheetName of wb.SheetNames) {
            const type = SHEET_TYPE_MAP[sheetName];
            if (!type) continue;

            const ws = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            const parsed = parseExcelSheet(rows, type);
            results.skipped += parsed.skipped;
            parsed.incomplete.forEach(inc => results.incomplete.push({ sheet: sheetName, ...inc }));

            for (const [roundName, roundData] of Object.entries(parsed.rounds)) {
                if (roundData.questions.length === 0) continue;

                // Coherence check: if Rondas sheet defines this round as a different type, skip with error
                if (hasRoundsSheet && roundDefs[roundName] && roundDefs[roundName].type !== type) {
                    results.errors.push(`Ronda "${roundName}" definida como ${roundDefs[roundName].type} en hoja Rondas, pero tiene preguntas en pestaña ${sheetName} (${type}). Preguntas ignoradas.`);
                    continue;
                }

                roundsWithQuestions.add(roundName);

                // Reuse round if already created in this import (same name, same type)
                const roundKey = `${roundName}__${type}`;
                let roundId = createdRounds[roundKey];

                if (!roundId) {
                    // Build round config: prefer Rondas sheet, fallback to old behavior
                    let roundConfig;
                    if (hasRoundsSheet && roundDefs[roundName]) {
                        roundConfig = { ...roundDefs[roundName].config };
                    } else {
                        // Legacy: build config from first question + fondo_ronda from parser
                        roundConfig = { time: 30, basePoints: 100, bonusMax: 50, penalty: 0 };
                        const firstQ = roundData.questions[0];
                        if (firstQ.config) {
                            if (firstQ.config.time) roundConfig.time = firstQ.config.time;
                            if (firstQ.config.basePoints) roundConfig.basePoints = firstQ.config.basePoints;
                            if (firstQ.config.bonusMax) roundConfig.bonusMax = firstQ.config.bonusMax;
                            if (firstQ.config.penalty) roundConfig.penalty = firstQ.config.penalty;
                        }
                        if (roundData.config.background) roundConfig.background = roundData.config.background;
                    }

                    roundId = newId('r');
                    insertRound.run(roundId, req.params.id, roundName, type, JSON.stringify(roundConfig), roundSortOrder++);
                    createdRounds[roundKey] = roundId;
                    results.rounds++;
                }

                roundData.questions.forEach((q, qIdx) => {
                    const qId = newId('q');
                    insertQuestion.run(qId, roundId, JSON.stringify(q.content), q.config ? JSON.stringify(q.config) : null, qIdx);
                    results.questions++;
                });
            }
        }

        // Create empty rounds from Rondas sheet that had no questions in any tab
        if (hasRoundsSheet) {
            for (const [name, def] of Object.entries(roundDefs)) {
                if (!roundsWithQuestions.has(name)) {
                    const roundId = newId('r');
                    insertRound.run(roundId, req.params.id, name, def.type, JSON.stringify(def.config), roundSortOrder++);
                    results.rounds++;
                }
            }
        }
    })();

    results.demoted = false;
    if (results.incomplete.length > 0) {
        const gameStatus = db.prepare('SELECT status FROM games WHERE id = ?').get(req.params.id);
        if (gameStatus && gameStatus.status === 'published') {
            db.prepare('UPDATE games SET status = ? WHERE id = ?').run('draft', req.params.id);
            results.demoted = true;
        }
    }

    console.log(`[Excel Import] Resultado: ${results.rounds} rondas, ${results.questions} preguntas importadas`);
    if (results.incomplete.length) console.log(`[Excel Import] Incompletas: ${results.incomplete.length}`, results.incomplete);
    if (results.demoted) console.log('[Excel Import] Juego degradado a borrador por preguntas incompletas');
    if (results.errors.length) console.log('[Excel Import] Errores:', results.errors);
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
module.exports.EXCEL_TYPE_DEFS = EXCEL_TYPE_DEFS;
module.exports.buildInstructionRows = buildInstructionRows;
