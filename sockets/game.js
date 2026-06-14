// Handlers de Socket.io con aislamiento por gameId (rooms `game:<gameId>`).
// Cada juego tiene su propio GameState en memoria; equipos se persisten en SQLite via sessions/teams.

const { db, DEFAULT_GAME_ID } = require('../db');

const ADMIN_PIN = process.env.ADMIN_PIN || '6174';

const gameStates = new Map();

function createGameState() {
    return {
        juegoIniciado: false,
        equipos: [],
        // equipo: { id, nombre, photo_url, ocupado, bonos: [], bloqueado: false, socketId, deviceId }
        vistaActual: 'pulsador',
        urlActual: '',
        urlsGuardadas: ['', '', ''],
        escenas: { espera: 'espera.jpg' },
        pulsadorActivo: false,
        colaPulsador: [],
        buzzerOpenedAt: null,
        bloqueoGlobal: false,
        precio: {
            tiempoSegundos: 30, tiempoInicio: null, respuestas: {},
            fase: 'config', ganadorId: null, cifraCorrecta: null
        },
        director: {
            phase: 'lobby',
            menuLevel: null, // 'home' | 'category' | null
            selectedCategory: null, // round type string when in category view
            currentRoundId: null, currentRound: null,
            questions: [], currentQuestionIdx: -1,
            timer: { total: 0, remaining: 0, running: false },
            scores: {}, answers: {},
            revealedCells: [],
            revealedLetters: [],       // legacy index-based (imagen type)
            rouletteRevealed: [],       // letter-based for ruleta (uppercase chars)
            rouletteSolved: false,
            roulettePanelVisible: false,
            imagePuzzle: { questionId: null, revealedTiles: [], answerVisible: false },
            identidad: null,
            completedRounds: [],
            optionsRevealed: false,
            lastQuestionScores: {},
            showTeamResults: false,
            scoreboardVisible: false,
            qrVisible: false,
        },
        precioCifraCorrecta: null,
        precioTimeoutHandle: null,
        _timerHandle: null,
        _sessionId: null,
    };
}

function getOrCreateState(gameId) {
    let s = gameStates.get(gameId);
    if (!s) {
        s = createGameState();
        s._gameTheme = loadGameTheme(gameId);
        s._rounds = db.prepare('SELECT id, name, type, config FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId);
        // Load teams from active session in DB
        const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(gameId);
        if (session) {
            s._sessionId = session.id;
            const dbTeams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
            s.equipos = dbTeams.map(t => ({
                id: t.id, nombre: t.name, photo_url: t.photo_url,
                ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: t.device_id
            }));
            s.director.scores = {};
            s.equipos.forEach(e => { s.director.scores[e.id] = 0; });
            if (s.equipos.length > 0) s.juegoIniciado = true;
        }
        gameStates.set(gameId, s);
    }
    return s;
}

function publicView(state) {
    const { precioCifraCorrecta, precioTimeoutHandle, _timerHandle, _gameTheme, _sessionId, _rounds, ...rest } = state;
    rest.gameTheme = _gameTheme || {};
    console.log('[DEBUG gameTheme]', JSON.stringify(rest.gameTheme));
    return rest;
}

function roomOf(gameId) { return `game:${gameId}`; }

function parseJson(str) {
    if (!str) return {};
    try { return JSON.parse(str); } catch { return {}; }
}

function loadRoundQuestions(roundId) {
    return db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sort_order').all(roundId)
        .map(q => ({ ...q, content: parseJson(q.content), config: parseJson(q.config) }));
}

function getQuestionConfig(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q) return { time: 30, basePoints: 100, bonusMax: 50, penalty: 0 };
    const rCfg = ds.currentRound ? parseJson(ds.currentRound.config) : {};
    const qCfg = q.config || {};
    return {
        time: qCfg.time || rCfg.time || 30,
        basePoints: qCfg.basePoints ?? rCfg.basePoints ?? 100,
        bonusMax: qCfg.bonusMax ?? rCfg.bonusMax ?? 50,
        penalty: qCfg.penalty ?? rCfg.penalty ?? 0,
    };
}

function initIdentidadState(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    if (ds.currentRound && ds.currentRound.type === 'identidad' && q && q.content && q.content.pairs) {
        const n = q.content.pairs.length;
        const indices = Array.from({length: n}, (_, i) => i);
        ds.identidad = { shuffledRight: shuffleNotIdentical(indices), revealIndex: 0 };
    } else {
        ds.identidad = null;
    }
}

function clearPreCountdown(state) {
    if (state._preCountdownHandle) { clearInterval(state._preCountdownHandle); state._preCountdownHandle = null; }
    delete state.director.preCountdown;
}

function stopTimer(state, gameId, io) {
    clearPreCountdown(state);
    if (state._timerHandle) { clearInterval(state._timerHandle); state._timerHandle = null; }
    state.director.timer.running = false;
}

function autoScorePrecio(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q || !q.content || q.content.correct_value === undefined) return;
    const correctValue = Number(q.content.correct_value);
    const cfg = getQuestionConfig(state);

    const entries = [];
    for (const [teamId, ans] of Object.entries(ds.answers)) {
        const value = Number(ans.answer);
        if (isNaN(value)) continue;
        entries.push({ teamId, value, timestamp: ans.timestamp, timerRemaining: ans.timerRemaining });
    }

    const valid = entries
        .filter(e => e.value <= correctValue)
        .sort((a, b) => {
            const da = correctValue - a.value, db = correctValue - b.value;
            if (da !== db) return da - db;
            return a.timestamp - b.timestamp;
        });

    const winnerId = valid.length > 0 ? valid[0].teamId : null;
    if (winnerId) {
        if (!ds.scores[winnerId]) ds.scores[winnerId] = 0;
        const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (valid[0].timerRemaining / ds.timer.total)) : 0;
        ds.scores[winnerId] += cfg.basePoints + bonus;
    }
}

function autoScoreMultirespuesta(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q || !q.content || q.content.correct === undefined) return;
    const correctSet = new Set(Array.isArray(q.content.correct) ? q.content.correct : [q.content.correct]);
    const cfg = getQuestionConfig(state);
    for (const [teamId, ans] of Object.entries(ds.answers)) {
        const picked = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
        const ok = picked.length === correctSet.size && picked.every(a => correctSet.has(a));
        if (!ds.scores[teamId]) ds.scores[teamId] = 0;
        if (ok) {
            const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
            ds.scores[teamId] += cfg.basePoints + bonus;
        } else if (cfg.penalty > 0) {
            ds.scores[teamId] -= cfg.penalty;
        }
    }
}

function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function shuffleNotIdentical(arr) {
    if (arr.length < 2) return arr.slice();
    let shuffled;
    do {
        shuffled = shuffleArray(arr);
    } while (JSON.stringify(shuffled) === JSON.stringify(arr));
    return shuffled;
}

function autoScoreIdentidad(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q || !q.content || !q.content.pairs) return;
    const pairs = q.content.pairs;
    const nPairs = pairs.length;
    if (nPairs === 0) return;
    const cfg = getQuestionConfig(state);

    for (const [teamId, ans] of Object.entries(ds.answers)) {
        const submitted = Array.isArray(ans.answer) ? ans.answer : [];
        let correctCount = 0;
        for (let i = 0; i < nPairs; i++) {
            if (i < submitted.length && submitted[i] === i) {
                correctCount++;
            }
        }
        if (!ds.scores[teamId]) ds.scores[teamId] = 0;
        const proportional = Math.floor(cfg.basePoints * correctCount / nPairs);
        if (correctCount === nPairs) {
            const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
            ds.scores[teamId] += proportional + bonus;
        } else {
            ds.scores[teamId] += proportional;
            if (cfg.penalty > 0 && correctCount < nPairs) {
                ds.scores[teamId] -= cfg.penalty;
            }
        }
    }
}

function autoScoreBoom(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q || !q.content || !q.content.correct_order) return;
    const order = q.content.correct_order;
    const cfg = getQuestionConfig(state);

    for (const [teamId, ans] of Object.entries(ds.answers)) {
        const submitted = Array.isArray(ans.answer) ? ans.answer : [];
        const ok = JSON.stringify(submitted) === JSON.stringify(order);
        if (!ds.scores[teamId]) ds.scores[teamId] = 0;
        if (ok) {
            const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
            ds.scores[teamId] += cfg.basePoints + bonus;
        } else if (cfg.penalty > 0) {
            ds.scores[teamId] -= cfg.penalty;
        }
    }
}

function computeLastQuestionScores(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q) { ds.lastQuestionScores = {}; return; }
    const c = q.content || {};
    const cfg = getQuestionConfig(state);
    const roundType = ds.currentRound ? ds.currentRound.type : '';
    const results = {};

    // Pre-calculate precio winner (needs all answers before per-team loop)
    let precioWinnerId = null;
    if (roundType === 'precio' && c.correct_value !== undefined) {
        const cv = Number(c.correct_value);
        const valid = Object.entries(ds.answers)
            .map(([tid, a]) => ({ teamId: tid, value: Number(a.answer), timestamp: a.timestamp, timerRemaining: a.timerRemaining }))
            .filter(e => !isNaN(e.value) && e.value <= cv)
            .sort((a, b) => { const da = cv - a.value, db = cv - b.value; return da !== db ? da - db : a.timestamp - b.timestamp; });
        precioWinnerId = valid.length > 0 ? valid[0].teamId : null;
    }

    for (const [teamId, ans] of Object.entries(ds.answers)) {
        const entry = { answer: ans.answer, correct: false, points: 0 };

        if (roundType === 'multirespuesta' && c.correct !== undefined) {
            const correctSet = new Set(Array.isArray(c.correct) ? c.correct : [c.correct]);
            const picked = Array.isArray(ans.answer) ? ans.answer : [ans.answer];
            entry.correct = picked.length === correctSet.size && picked.every(a => correctSet.has(a));
            if (entry.correct) {
                const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
                entry.points = cfg.basePoints + bonus;
            } else if (cfg.penalty > 0) {
                entry.points = -cfg.penalty;
            }
        } else if (roundType === 'precio' && c.correct_value !== undefined) {
            const val = Number(ans.answer);
            const cv = Number(c.correct_value);
            entry.correct = teamId === precioWinnerId;
            entry.passed = val > cv;
            entry.delta = cv - val;
            if (entry.correct) {
                const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
                entry.points = cfg.basePoints + bonus;
            }
        } else if (roundType === 'boom' && c.correct_order) {
            const order = c.correct_order;
            const submitted = Array.isArray(ans.answer) ? ans.answer : [];
            entry.correct = JSON.stringify(submitted) === JSON.stringify(order);
            if (entry.correct) {
                const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
                entry.points = cfg.basePoints + bonus;
            } else if (cfg.penalty > 0) {
                entry.points = -cfg.penalty;
            }
        } else if (roundType === 'identidad' && c.pairs) {
            const nPairs = c.pairs.length;
            const submitted = Array.isArray(ans.answer) ? ans.answer : [];
            let correctCount = 0;
            for (let i = 0; i < nPairs; i++) {
                if (i < submitted.length && submitted[i] === i) {
                    correctCount++;
                }
            }
            entry.correct = correctCount === nPairs;
            entry.correctCount = correctCount;
            entry.totalPairs = nPairs;
            const proportional = Math.floor(cfg.basePoints * correctCount / nPairs);
            if (entry.correct) {
                const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ans.timerRemaining / ds.timer.total)) : 0;
                entry.points = proportional + bonus;
            } else {
                entry.points = proportional;
                if (cfg.penalty > 0 && correctCount < nPairs) {
                    entry.points -= cfg.penalty;
                }
            }
        }
        results[teamId] = entry;
    }

    // Mark teams that didn't answer
    for (const eq of state.equipos) {
        if (!results[eq.id]) {
            results[eq.id] = { answer: null, correct: false, points: 0, noAnswer: true };
        }
    }

    ds.lastQuestionScores = results;
    ds.showTeamResults = false;
}

function loadGameTheme(gameId) {
    const row = db.prepare('SELECT theme FROM games WHERE id = ?').get(gameId);
    return row ? parseJson(row.theme) : {};
}

function resolveTypeTheme(state, roundType) {
    if (!roundType) return {};
    const gt = state._gameTheme || {};
    return (gt.types && gt.types[roundType]) || {};
}

function playerView(state) {
    const ds = state.director;
    const curQ = ds.questions[ds.currentQuestionIdx];
    let question = null;
    if (curQ && (ds.phase === 'question' || ds.phase === 'answer_revealed')) {
        const c = { ...curQ.content };
        if (ds.phase === 'question') {
            if (ds.currentRound && ds.currentRound.type === 'multirespuesta' && !ds.optionsRevealed) {
                delete c.options;
            }
            if (ds.currentRound && ds.currentRound.type === 'boom' && !ds.optionsRevealed) {
                delete c.items;
            }
            // Identidad: gate right column and explanation
            if (ds.currentRound && ds.currentRound.type === 'identidad') {
                delete c.explanation;
                if (c.pairs) {
                    if (!ds.optionsRevealed) {
                        c.pairs = c.pairs.map(p => ({ left: p.left }));
                    } else {
                        c.rightsCanonical = c.pairs.map(p => p.right);
                        c.pairs = c.pairs.map(p => ({ left: p.left }));
                        c.rightShuffled = ds.identidad ? ds.identidad.shuffledRight : [];
                    }
                }
            }
            delete c.correct; delete c.answer; delete c.correct_value; delete c.correct_order;
        }
        // Identidad answer_revealed: gate by revealIndex, show explanation
        if (ds.phase === 'answer_revealed' && ds.currentRound && ds.currentRound.type === 'identidad') {
            if (c.pairs && ds.identidad) {
                c.revealedPairs = c.pairs.slice(0, ds.identidad.revealIndex);
                c.rightsCanonical = c.pairs.map(p => p.right);
                c.pairs = c.pairs.map(p => ({ left: p.left }));
                c.rightShuffled = ds.identidad.shuffledRight;
            }
        }
        question = { id: curQ.id, content: c, media_url: curQ.media_url };
    }
    // Compute precio winner for display
    let precioWinner = null;
    if (ds.phase === 'answer_revealed' && ds.currentRound && ds.currentRound.type === 'precio') {
        const lqs = ds.lastQuestionScores || {};
        for (const [tid, r] of Object.entries(lqs)) {
            if (r.correct) {
                const eq = state.equipos.find(e => e.id === tid);
                precioWinner = { teamId: tid, name: eq ? eq.nombre : tid, value: r.answer, points: r.points };
                break;
            }
        }
    }

    const roundCfg = ds.currentRound ? parseJson(ds.currentRound.config) : {};
    // Build rounds summary for menu navigation (lightweight: id, name, type, config logo)
    const roundsSummary = (state._rounds || []).map(r => {
        const cfg = parseJson(r.config);
        return { id: r.id, name: r.name, type: r.type, logo: cfg.logo || null };
    });
    return {
        phase: ds.phase,
        menuLevel: ds.menuLevel,
        selectedCategory: ds.selectedCategory,
        roundType: ds.currentRound ? ds.currentRound.type : null,
        roundName: ds.currentRound ? ds.currentRound.name : null,
        question,
        questionIdx: ds.currentQuestionIdx,
        totalQuestions: ds.questions.length,
        timer: { total: ds.timer.total, remaining: ds.timer.remaining, running: ds.timer.running },
        scores: ds.scores,
        answeredTeams: Object.entries(ds.answers).filter(([, a]) => a.submitted !== false).map(([tid]) => tid),
        equipos: state.equipos.map(e => ({ id: e.id, nombre: e.nombre, photo_url: e.photo_url, ocupado: e.ocupado, bloqueado: e.bloqueado })),
        pulsadorActivo: state.pulsadorActivo,
        colaPulsador: state.colaPulsador,
        bloqueoGlobal: state.bloqueoGlobal,
        revealedCells: ds.revealedCells,
        revealedLetters: ds.revealedLetters,
        rouletteRevealed: ds.rouletteRevealed,
        rouletteSolved: ds.rouletteSolved,
        roulettePanelVisible: ds.roulettePanelVisible,
        imagePuzzle: ds.imagePuzzle,
        optionsRevealed: ds.optionsRevealed,
        completedRounds: ds.completedRounds,
        lastQuestionScores: ds.lastQuestionScores,
        showTeamResults: ds.showTeamResults,
        scoreboardVisible: ds.scoreboardVisible,
        qrVisible: ds.qrVisible,
        preCountdown: ds.preCountdown || 0,
        gameTheme: state._gameTheme || {},
        typeTheme: resolveTypeTheme(state, ds.currentRound ? ds.currentRound.type : null),
        roundTheme: { logo: roundCfg.logo || null, background: roundCfg.background || null },
        rounds: roundsSummary,
        precioWinner,
        videoState: ds.videoState || null,
        identidad: ds.identidad ? { revealIndex: ds.identidad.revealIndex } : null,
    };
}

function emitYourOrder(socket, state) {
    if (!socket.equipoId) return;
    const ds = state.director;
    if (!(ds.currentRound && ds.currentRound.type === 'identidad')) return;
    const entry = ds.answers[socket.equipoId];
    if (!entry) return;
    socket.emit('game:your_order', { order: entry.answer, submitted: !!entry.submitted });
}

function broadcastDirector(io, gameId, state) {
    io.to(`directors:${gameId}`).emit('game:director_sync', publicView(state));
    io.to(roomOf(gameId)).emit('game:player_sync', playerView(state));
}

function resolveGameId(requestedId) {
    if (!requestedId) return DEFAULT_GAME_ID;
    const row = db.prepare('SELECT id FROM games WHERE id = ?').get(requestedId);
    return row ? row.id : DEFAULT_GAME_ID;
}

function attachSocketHandlers(io) {
    io.on('connection', (socket) => {
        const requested = socket.handshake.query && socket.handshake.query.gameId;
        const gameId = resolveGameId(requested);
        const deviceId = socket.handshake.query && socket.handshake.query.deviceId;
        socket.gameId = gameId;
        socket.join(roomOf(gameId));

        const state = getOrCreateState(gameId);

        socket.emit('init_connection', {
            juegoIniciado: state.juegoIniciado,
            estadoJuego: publicView(state),
            equipos: state.equipos,
            gameId
        });

        function finalizarPrecio() {
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.precio.fase = 'resultado';
            state.precio.cifraCorrecta = state.precioCifraCorrecta;
            const cifra = state.precioCifraCorrecta;
            const ordenados = Object.entries(state.precio.respuestas)
                .filter(([, r]) => r.valor <= cifra)
                .sort((a, b) => {
                    if (b[1].valor !== a[1].valor) return b[1].valor - a[1].valor;
                    return a[1].tiempo - b[1].tiempo;
                });
            state.precio.ganadorId = ordenados.length > 0 ? ordenados[0][0] : null;
            io.to(roomOf(gameId)).emit('precio_resultado', {
                cifraCorrecta: cifra, respuestas: state.precio.respuestas, ganadorId: state.precio.ganadorId
            });
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        }

        // ═══════════════════════ PLAYER TEAM REGISTRATION ═══════════════════════

        socket.on('player:register_team', (data) => {
            if (!data || !data.name || !data.name.trim()) return;
            const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(gameId);
            if (!session) { socket.emit('register_error', { error: 'No hay sesión activa' }); return; }

            const teamName = data.name.trim();
            const photoUrl = data.photo_url || null;
            const devId = data.deviceId || deviceId || null;

            // Check if device already has a team
            if (devId) {
                const existingDb = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, devId);
                if (existingDb) {
                    // Reconnect to existing team
                    let eq = state.equipos.find(e => e.id === existingDb.id);
                    if (!eq) {
                        eq = { id: existingDb.id, nombre: existingDb.name, photo_url: existingDb.photo_url, ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: devId };
                        state.equipos.push(eq);
                        if (!state.director.scores[eq.id]) state.director.scores[eq.id] = 0;
                    }
                    eq.ocupado = true;
                    eq.socketId = socket.id;
                    socket.equipoId = eq.id;
                    state._gameTheme = loadGameTheme(gameId);
                    socket.emit('login_success', { miEquipo: eq, estado: publicView(state), equiposRivales: state.equipos });
                    socket.emit('game:player_sync', playerView(state));
                    emitYourOrder(socket, state);
                    broadcastDirector(io, gameId, state);
                    return;
                }
            }

            // Create new team in DB
            const crypto = require('crypto');
            const teamId = 't_' + crypto.randomBytes(4).toString('hex');
            db.prepare('INSERT INTO teams (id, session_id, name, photo_url, device_id) VALUES (?, ?, ?, ?, ?)')
                .run(teamId, session.id, teamName, photoUrl, devId);

            const eq = { id: teamId, nombre: teamName, photo_url: photoUrl, ocupado: true, bonos: [], bloqueado: false, socketId: socket.id, deviceId: devId };
            state.equipos.push(eq);
            state.director.scores[teamId] = 0;
            state.juegoIniciado = true;
            socket.equipoId = teamId;

            state._gameTheme = loadGameTheme(gameId);
            socket.emit('login_success', { miEquipo: eq, estado: publicView(state), equiposRivales: state.equipos });
            socket.emit('game:player_sync', playerView(state));
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        // Device-based auto-reconnect
        socket.on('player:reconnect', (data) => {
            const devId = data && data.deviceId || deviceId;
            if (!devId) { socket.emit('reconnect_failed', { reason: 'no_device' }); return; }
            const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(gameId);
            if (!session) { socket.emit('reconnect_failed', { reason: 'no_session' }); return; }
            const dbTeam = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, devId);
            if (!dbTeam) { socket.emit('reconnect_failed', { reason: 'no_team' }); return; }

            let eq = state.equipos.find(e => e.id === dbTeam.id);
            if (!eq) {
                eq = { id: dbTeam.id, nombre: dbTeam.name, photo_url: dbTeam.photo_url, ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: devId };
                state.equipos.push(eq);
                if (!state.director.scores[eq.id]) state.director.scores[eq.id] = 0;
            }

            // Takeover: if previous socket is dead, allow
            if (eq.ocupado && eq.socketId && eq.socketId !== socket.id) {
                const prev = io.sockets.sockets.get(eq.socketId);
                if (prev && prev.connected) { socket.emit('reconnect_failed', { reason: 'slot_taken' }); return; }
            }

            eq.ocupado = true;
            eq.socketId = socket.id;
            socket.equipoId = eq.id;

            state._gameTheme = loadGameTheme(gameId);
            socket.emit('login_success', { miEquipo: eq, estado: publicView(state), equiposRivales: state.equipos });
            socket.emit('game:player_sync', playerView(state));
            emitYourOrder(socket, state);
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ LEGACY JOIN (keep for compat) ═══════════════════════

        socket.on('join_team', (data) => {
            const equipo = state.equipos.find(e => e.id === data.id);
            if (!equipo) return;
            if (equipo.ocupado && equipo.socketId && equipo.socketId !== socket.id) {
                const prev = io.sockets.sockets.get(equipo.socketId);
                if (prev && prev.connected) {
                    socket.emit('join_team_rejected', { motivo: 'ocupado', equipoId: equipo.id });
                    return;
                }
            }
            equipo.ocupado = true;
            equipo.socketId = socket.id;
            socket.equipoId = equipo.id;
            state._gameTheme = loadGameTheme(gameId);
            socket.emit('login_success', { miEquipo: equipo, estado: publicView(state), equiposRivales: state.equipos });
            socket.emit('game:player_sync', playerView(state));
            emitYourOrder(socket, state);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ ADMIN (legacy) ═══════════════════════

        socket.on('login_admin', (pin) => {
            if (String(pin).trim() === ADMIN_PIN) {
                socket.isAdmin = true;
                socket.emit('admin_auth_success', {
                    equipos: state.equipos, estadoJuego: publicView(state),
                    juegoIniciado: state.juegoIniciado, precioCifra: state.precioCifraCorrecta, gameId
                });
            } else { socket.emit('admin_auth_fail'); }
        });

        socket.on('admin_crear_juego', (n) => {
            const total = Math.max(1, Math.min(20, Number(n) || 0));
            state.equipos = [];
            for (let i = 1; i <= total; i++) {
                state.equipos.push({ id: `eq${i}`, nombre: `Equipo ${i}`, photo_url: null, ocupado: false, bonos: [], bloqueado: false });
            }
            state.juegoIniciado = true;
            state.colaPulsador = [];
            state.bloqueoGlobal = false;
            state.pulsadorActivo = false;
            io.to(roomOf(gameId)).emit('juego_iniciado_teams', state.equipos);
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        socket.on('admin_rename_team', (data) => {
            const eq = state.equipos.find(e => e.id === data.id);
            if (!eq) return;
            eq.nombre = data.nuevoNombre;
            // Persist to DB if team is from a session
            db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(eq.nombre, eq.id);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_control_pulsador', (acc) => {
            if (acc === 'abrir')  state.pulsadorActivo = true;
            if (acc === 'pausar') state.pulsadorActivo = false;
            if (acc === 'reset')  { state.pulsadorActivo = false; state.colaPulsador = []; }
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: state.pulsadorActivo, cola: state.colaPulsador });
        });

        socket.on('admin_config_escenas', (data) => {
            state.escenas.espera = data.espera;
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
            if (state.vistaActual === 'espera') io.to(roomOf(gameId)).emit('cambio_de_escena', publicView(state));
        });

        socket.on('admin_set_escena', (d) => {
            state.vistaActual = d.vista;
            if (d.vista === 'web' && d.url) state.urlActual = d.url;
            if (d.saveSlot !== undefined && d.urlToSave) state.urlsGuardadas[d.saveSlot] = d.urlToSave;
            io.to(roomOf(gameId)).emit('cambio_de_escena', publicView(state));
        });

        socket.on('admin_gestionar_bono', (data) => {
            const eq = state.equipos.find(e => e.id === data.equipoId);
            if (!eq) return;
            if (data.accion === 'add') eq.bonos.push(data.tipo);
            else if (data.accion === 'remove') {
                const idx = eq.bonos.indexOf(data.tipo);
                if (idx > -1) eq.bonos.splice(idx, 1);
            }
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_toggle_bloqueo', (data) => {
            const eq = state.equipos.find(e => e.id === data.equipoId);
            if (!eq) return;
            eq.bloqueado = data.bloqueado;
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_toggle_global_lock', (valor) => {
            state.bloqueoGlobal = valor;
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        socket.on('admin_reset_total', () => {
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.juegoIniciado = false;
            state.equipos = [];
            state.colaPulsador = [];
            state.precio = { tiempoSegundos: 30, tiempoInicio: null, respuestas: {}, fase: 'config', ganadorId: null, cifraCorrecta: null };
            state.precioCifraCorrecta = null;
            io.to(roomOf(gameId)).emit('reset_total_client');
        });

        socket.on('admin_precio_set_cifra', (valor) => {
            const n = Number(valor);
            if (!isFinite(n)) return;
            state.precioCifraCorrecta = n;
            socket.emit('admin_precio_cifra_sync', state.precioCifraCorrecta);
        });

        socket.on('admin_precio_set_tiempo', (segundos) => {
            const n = Number(segundos);
            if (!isFinite(n) || n < 5) return;
            state.precio.tiempoSegundos = Math.round(n);
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        socket.on('admin_precio_nueva_partida', () => {
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.precio.respuestas = {};
            state.precio.tiempoInicio = null;
            state.precio.fase = 'config';
            state.precio.ganadorId = null;
            state.precio.cifraCorrecta = null;
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        socket.on('admin_precio_iniciar', () => {
            if (state.precioCifraCorrecta === null) {
                socket.emit('notificacion_bono', { msg: '❌ Define una cifra antes de comenzar' });
                return;
            }
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.precio.respuestas = {};
            state.precio.tiempoInicio = Date.now();
            state.precio.fase = 'jugando';
            state.precio.ganadorId = null;
            state.precio.cifraCorrecta = null;
            state.precioTimeoutHandle = setTimeout(finalizarPrecio, state.precio.tiempoSegundos * 1000);
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        socket.on('admin_precio_forzar_resultado', () => {
            if (state.precio.fase === 'jugando') finalizarPrecio();
        });

        socket.on('precio_enviar_respuesta', (data) => {
            if (state.precio.fase !== 'jugando') return;
            const eq = state.equipos.find(e => e.id === socket.equipoId);
            if (!eq) return;
            const valor = Number(data && data.valor);
            if (!isFinite(valor)) return;
            if (state.precio.respuestas[eq.id]) return;
            state.precio.respuestas[eq.id] = { valor, tiempo: Date.now() };
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        // ═══════════════════════ PLAYER ANSWERS ═══════════════════════

        socket.on('pulsar_boton', () => {
            const e = state.equipos.find(x => x.id === socket.equipoId);
            if (!e) return;
            if (!state.pulsadorActivo || state.bloqueoGlobal || e.bloqueado) return;
            if (state.colaPulsador.find(p => p.id === e.id)) return;
            var elapsed = state.buzzerOpenedAt ? Date.now() - state.buzzerOpenedAt : 0;
            state.colaPulsador.push({ id: e.id, nombre: e.nombre, tiempo: Date.now(), elapsed: elapsed });
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_answer', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            ds.answers[socket.equipoId] = { answer: data.answer, timestamp: Date.now(), timerRemaining: ds.timer.remaining };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_price', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            const val = Number(data && data.value);
            if (!isFinite(val)) return;
            ds.answers[socket.equipoId] = { answer: val, timestamp: Date.now(), timerRemaining: ds.timer.remaining };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_order', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (!Array.isArray(data.order)) return;
            const existing = ds.answers[socket.equipoId];
            // For identidad: allow promoting provisional to definitive
            if (existing) {
                if (ds.currentRound && ds.currentRound.type === 'identidad' && !existing.submitted) {
                    existing.answer = data.order;
                    existing.timestamp = Date.now();
                    existing.timerRemaining = ds.timer.remaining;
                    existing.submitted = true;
                } else {
                    return; // Already submitted (Boom or identidad definitive)
                }
            } else {
                ds.answers[socket.equipoId] = { answer: data.order, timestamp: Date.now(), timerRemaining: ds.timer.remaining, submitted: true };
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:update_order', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (!ds.optionsRevealed) return;
            if (!(ds.currentRound && ds.currentRound.type === 'identidad')) return;
            if (!Array.isArray(data.order)) return;
            const existing = ds.answers[socket.equipoId];
            if (existing && existing.submitted) return;
            ds.answers[socket.equipoId] = { answer: data.order, timestamp: Date.now(), timerRemaining: ds.timer.remaining, submitted: false };
        });

        socket.on('usar_bono', (data) => {
            const emisor = state.equipos.find(e => e.id === socket.equipoId);
            if (!emisor || !emisor.bonos.includes(data.tipo)) return;
            let mensaje = '';
            if (data.tipo === 'lock_all') {
                state.equipos.forEach(eq => {
                    if (eq.id !== emisor.id) { eq.bloqueado = true; if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); }
                });
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                mensaje = `${emisor.nombre} BLOQUEÓ A RIVALES`;
            } else if (data.tipo === 'freeze') {
                let victima = state.equipos.find(e => e.id === data.targetId);
                if (!victima) { socket.emit('notificacion_bono', { msg: 'Equipo no encontrado' }); return; }
                if (victima.id === emisor.id) { socket.emit('notificacion_bono', { msg: 'No te puedes congelar a ti mismo' }); return; }
                victima.bloqueado = true;
                mensaje = `${emisor.nombre} CONGELÓ A ${victima.nombre}`;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (victima.socketId) io.to(victima.socketId).emit('update_mi_equipo', victima);
            }
            const idx = emisor.bonos.indexOf(data.tipo);
            if (idx > -1) emisor.bonos.splice(idx, 1);
            socket.emit('update_mi_equipo', emisor);
            io.to(roomOf(gameId)).emit('notificacion_bono', { msg: mensaje });
        });

        // ═══════════════════════ DIRECTOR ═══════════════════════

        socket.on('director:join', () => {
            socket.isDirector = true;
            socket.join(`directors:${gameId}`);
            socket.emit('game:director_sync', publicView(state));
        });

        socket.on('screen:join', () => {
            state._gameTheme = loadGameTheme(gameId);
            socket.emit('game:player_sync', playerView(state));
        });

        socket.on('director:refresh_content', () => {
            const ds = state.director;
            if (ds.currentRoundId) {
                ds.questions = loadRoundQuestions(ds.currentRoundId);
                if (ds.currentQuestionIdx >= ds.questions.length) {
                    ds.currentQuestionIdx = Math.max(0, ds.questions.length - 1);
                }
                const freshRound = db.prepare('SELECT name, config FROM rounds WHERE id = ?').get(ds.currentRoundId);
                if (freshRound) {
                    ds.currentRound.name = freshRound.name;
                    ds.currentRound.config = freshRound.config;
                }
            }
            state._rounds = db.prepare('SELECT id, name, type, config FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId);
            state._gameTheme = loadGameTheme(gameId);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:create_teams', (data) => {
            const count = Math.max(1, Math.min(20, Number(data && data.count) || 0));
            state.equipos = [];
            state.director.scores = {};
            for (let i = 1; i <= count; i++) {
                const id = `eq${i}`;
                state.equipos.push({ id, nombre: `Equipo ${i}`, photo_url: null, ocupado: false, bonos: [], bloqueado: false });
                state.director.scores[id] = 0;
            }
            state.juegoIniciado = true;
            state.colaPulsador = [];
            state.bloqueoGlobal = false;
            state.pulsadorActivo = false;
            io.to(roomOf(gameId)).emit('juego_iniciado_teams', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:start_game', () => {
            state.juegoIniciado = true;
            state.director.phase = 'lobby';
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:update_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (!eq) return;
            if (data.name) { eq.nombre = data.name.trim(); db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(eq.nombre, eq.id); }
            if (data.photo_url !== undefined) { eq.photo_url = data.photo_url || null; db.prepare('UPDATE teams SET photo_url = ? WHERE id = ?').run(eq.photo_url, eq.id); }
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:remove_team', (data) => {
            if (!data || !data.teamId) return;
            const idx = state.equipos.findIndex(e => e.id === data.teamId);
            if (idx < 0) return;
            const eq = state.equipos[idx];
            if (eq.socketId) io.to(eq.socketId).emit('team_removed');
            state.equipos.splice(idx, 1);
            delete state.director.scores[data.teamId];
            db.prepare('DELETE FROM teams WHERE id = ?').run(data.teamId);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:launch_round', (data) => {
            if (!data || !data.roundId) return;
            const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(data.roundId);
            if (!round) return;
            stopTimer(state, gameId, io);
            const ds = state.director;
            ds.currentRoundId = round.id;
            ds.currentRound = { id: round.id, name: round.name, type: round.type, config: round.config };
            ds.questions = loadRoundQuestions(round.id);
            ds.currentQuestionIdx = -1;
            ds.phase = 'round_intro';
            ds.answers = {};
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:start_round', () => {
            const ds = state.director;
            if (ds.currentRound && ds.questions.length > 0) {
                ds.currentQuestionIdx = 0;
                ds.phase = 'question';
                ds.answers = {};
                ds.revealedCells = [];
                ds.revealedLetters = [];
                ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
                ds.optionsRevealed = false;
                ds.lastQuestionScores = {};
                ds.showTeamResults = false;
                ds.scoreboardVisible = false;
                ds.qrVisible = false;
                ds.menuLevel = null;
                ds.selectedCategory = null;
                initIdentidadState(ds);
                if (ds.currentRound.type === 'pulsador' || ds.currentRound.type === 'imagen') {
                    ds.timer = { total: 0, remaining: 0, running: false };
                } else {
                    const cfg = getQuestionConfig(state);
                    ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                }
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:launch_question', (data) => {
            const ds = state.director;
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0 || idx >= ds.questions.length) return;
            stopTimer(state, gameId, io);
            ds.currentQuestionIdx = idx;
            ds.phase = 'question';
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
            ds.optionsRevealed = false;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            initIdentidadState(ds);
            if (ds.currentRound && ds.currentRound.type === 'pulsador') {
                ds.timer = { total: 0, remaining: 0, running: false };
            } else {
                const cfg = getQuestionConfig(state);
                ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
            }
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:next_question', () => {
            const ds = state.director;
            if (ds.currentQuestionIdx < ds.questions.length - 1) {
                stopTimer(state, gameId, io);
                ds.currentQuestionIdx++;
                ds.phase = 'question';
                ds.answers = {};
                ds.revealedCells = [];
                ds.revealedLetters = [];
                ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
                ds.optionsRevealed = false;
                initIdentidadState(ds);
                if (ds.currentRound && ds.currentRound.type === 'pulsador' || ds.currentRound.type === 'imagen') {
                    ds.timer = { total: 0, remaining: 0, running: false };
                } else {
                    const cfg = getQuestionConfig(state);
                    ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                }
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:prev_question', () => {
            const ds = state.director;
            if (ds.currentQuestionIdx > 0) {
                stopTimer(state, gameId, io);
                ds.currentQuestionIdx--;
                ds.phase = 'question';
                ds.answers = {};
                ds.revealedCells = [];
                ds.revealedLetters = [];
                ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
                ds.optionsRevealed = false;
                initIdentidadState(ds);
                if (ds.currentRound && ds.currentRound.type === 'pulsador' || ds.currentRound.type === 'imagen') {
                    ds.timer = { total: 0, remaining: 0, running: false };
                } else {
                    const cfg = getQuestionConfig(state);
                    ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                }
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:start_timer', () => {
            const ds = state.director;
            clearPreCountdown(state);
            if (ds.timer.running || ds.timer.remaining <= 0) return;
            ds.timer.running = true;
            // Auto-reveal options for multirespuesta/precio when timer starts
            if (ds.currentRound && (ds.currentRound.type === 'multirespuesta' || ds.currentRound.type === 'precio')) {
                ds.optionsRevealed = true;
            }
            state._timerHandle = setInterval(() => {
                ds.timer.remaining = Math.max(0, ds.timer.remaining - 1);
                io.to(roomOf(gameId)).emit('game:timer_tick', { remaining: ds.timer.remaining, total: ds.timer.total });
                if (ds.timer.remaining <= 0) {
                    stopTimer(state, gameId, io);
                    // Auto-reveal answer when timer expires
                    if (ds.phase === 'question') {
                        if (ds.currentRound && ds.currentRound.type === 'multirespuesta') {
                            autoScoreMultirespuesta(state);
                        } else if (ds.currentRound && ds.currentRound.type === 'precio') {
                            autoScorePrecio(state);
                        } else if (ds.currentRound && ds.currentRound.type === 'identidad') {
                            // Promote provisional orders to definitive
                            for (const [tid, ans] of Object.entries(ds.answers)) {
                                if (!ans.submitted) {
                                    ans.submitted = true;
                                    ans.timerRemaining = 0;
                                }
                            }
                            autoScoreIdentidad(state);
                        } else if (ds.currentRound && ds.currentRound.type === 'boom') {
                            autoScoreBoom(state);
                        }
                        ds.phase = 'answer_revealed';
                        state.pulsadorActivo = false;
                        computeLastQuestionScores(state);
                    }
                    broadcastDirector(io, gameId, state);
                }
            }, 1000);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:stop_timer', () => {
            stopTimer(state, gameId, io);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:extend_timer', (data) => {
            const secs = Math.max(1, Math.min(120, Number(data && data.seconds) || 10));
            state.director.timer.remaining += secs;
            state.director.timer.total += secs;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reveal_answer', () => {
            stopTimer(state, gameId, io);
            const ds = state.director;
            if (ds.phase === 'question') {
                if (ds.currentRound && ds.currentRound.type === 'multirespuesta') {
                    autoScoreMultirespuesta(state);
                } else if (ds.currentRound && ds.currentRound.type === 'precio') {
                    autoScorePrecio(state);
                } else if (ds.currentRound && ds.currentRound.type === 'identidad') {
                    for (const [tid, ans] of Object.entries(ds.answers)) {
                        if (!ans.submitted) {
                            ans.submitted = true;
                            ans.timerRemaining = ds.timer.remaining;
                        }
                    }
                    autoScoreIdentidad(state);
                } else if (ds.currentRound && ds.currentRound.type === 'boom') {
                    autoScoreBoom(state);
                }
            }
            ds.phase = 'answer_revealed';
            state.pulsadorActivo = false;
            computeLastQuestionScores(state);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:open_buzzer', () => {
            state.pulsadorActivo = true;
            state.colaPulsador = [];
            state.buzzerOpenedAt = Date.now();
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: true, cola: [] });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:close_buzzer', () => {
            state.pulsadorActivo = false;
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: false, cola: state.colaPulsador });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reset_buzzer', () => {
            state.colaPulsador = [];
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reveal_cell', (data) => {
            const ds = state.director;
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0) return;
            if (ds.revealedCells.indexOf(idx) === -1) { ds.revealedCells.push(idx); broadcastDirector(io, gameId, state); }
        });

        socket.on('director:reveal_all_cells', () => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const grid = (q.content && q.content.grid) || 4;
            const total = grid * grid;
            ds.revealedCells = [];
            for (let i = 0; i < total; i++) ds.revealedCells.push(i);
            broadcastDirector(io, gameId, state);
        });

        // Legacy index-based letter reveal (kept for imagen type compat)
        socket.on('director:reveal_letter', (data) => {
            const ds = state.director;
            // New: if data.letter is a string, use letter-based reveal for ruleta
            if (data && typeof data.letter === 'string') {
                const letter = data.letter.toUpperCase();
                if (letter && ds.rouletteRevealed.indexOf(letter) === -1) {
                    ds.rouletteRevealed.push(letter);
                    io.to(roomOf(gameId)).emit('game:letter_revealed', { letter: letter, revealedLetters: ds.rouletteRevealed });
                    broadcastDirector(io, gameId, state);
                }
                return;
            }
            // Legacy: index-based
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0) return;
            if (ds.revealedLetters.indexOf(idx) === -1) { ds.revealedLetters.push(idx); broadcastDirector(io, gameId, state); }
        });

        socket.on('director:reveal_all_letters', () => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const phrase = (q.content && q.content.phrase) || '';
            // Legacy index-based (for imagen type)
            ds.revealedLetters = [];
            for (let i = 0; i < phrase.length; i++) ds.revealedLetters.push(i);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:solve_roulette', () => {
            const ds = state.director;
            ds.rouletteSolved = true;
            // Close buzzer when solving
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: false, cola: [] });
            const q = ds.questions[ds.currentQuestionIdx];
            const phrase = q ? (q.content && q.content.phrase || '') : '';
            io.to(roomOf(gameId)).emit('game:roulette_solved', { phrase: phrase });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reset_roulette', () => {
            const ds = state.director;
            ds.rouletteRevealed = [];
            ds.rouletteSolved = false;
            // Keep panel visible — just reset letters
            // Reset buzzer queue too
            state.colaPulsador = [];
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: state.pulsadorActivo, cola: [] });
            io.to(roomOf(gameId)).emit('game:roulette_reset');
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:show_roulette_panel', () => {
            state.director.roulettePanelVisible = true;
            io.to(roomOf(gameId)).emit('game:panel_visible');
            // Also open buzzer
            state.pulsadorActivo = true;
            state.colaPulsador = [];
            state.buzzerOpenedAt = Date.now();
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: true, cola: [] });
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ IMAGEN PUZZLE ═══════════════════════

        socket.on('director:image_reveal_tile', (data) => {
            const ds = state.director;
            const idx = Number(data && data.tileIndex);
            if (!isFinite(idx) || idx < 0) return;
            if (ds.imagePuzzle.revealedTiles.indexOf(idx) === -1) {
                const wasEmpty = ds.imagePuzzle.revealedTiles.length === 0;
                ds.imagePuzzle.revealedTiles.push(idx);
                // Auto-open buzzer on first tile reveal
                if (wasEmpty && !state.pulsadorActivo) {
                    state.pulsadorActivo = true;
                    state.colaPulsador = [];
                    state.buzzerOpenedAt = Date.now();
                    io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: true, cola: [] });
                }
                io.to(roomOf(gameId)).emit('game:image_tiles_updated', { revealedTiles: ds.imagePuzzle.revealedTiles });
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:image_reveal_all', () => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const c = q.content || {};
            const rows = c.grid_rows || 4;
            const cols = c.grid_cols || 6;
            const total = rows * cols;
            ds.imagePuzzle.revealedTiles = [];
            for (let i = 0; i < total; i++) ds.imagePuzzle.revealedTiles.push(i);
            io.to(roomOf(gameId)).emit('game:image_tiles_updated', { revealedTiles: ds.imagePuzzle.revealedTiles });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:image_reset', () => {
            const ds = state.director;
            ds.imagePuzzle.revealedTiles = [];
            ds.imagePuzzle.answerVisible = false;
            ds.imagePuzzle.answerText = '';
            io.to(roomOf(gameId)).emit('game:image_tiles_updated', { revealedTiles: [] });
            io.to(roomOf(gameId)).emit('game:image_answer_updated', { visible: false });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:image_toggle_answer', () => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const answer = (q.content && q.content.answer) || '';
            if (!answer) return;
            ds.imagePuzzle.answerVisible = !ds.imagePuzzle.answerVisible;
            ds.imagePuzzle.answerText = ds.imagePuzzle.answerVisible ? answer : '';
            io.to(roomOf(gameId)).emit('game:image_answer_updated', { visible: ds.imagePuzzle.answerVisible, answer: answer });
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ IDENTIDAD REVEAL ═══════════════════════

        socket.on('director:reveal_next_pair', () => {
            const ds = state.director;
            if (!ds.identidad) return;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q || !q.content || !q.content.pairs) return;
            if (ds.identidad.revealIndex >= q.content.pairs.length) return;
            ds.identidad.revealIndex++;
            io.to(roomOf(gameId)).emit('game:pair_revealed', { index: ds.identidad.revealIndex - 1 });
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ VIDEO CONTROL (imagen_fija) ═══════════════════════

        socket.on('director:video_command', (data) => {
            const action = data && data.action;
            if (action !== 'play' && action !== 'pause' && action !== 'restart') return;
            const ds = state.director;
            ds.videoState = { action, ts: Date.now() };
            io.to(roomOf(gameId)).emit('game:video_command', { action });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:mark_correct', (data) => {
            if (!data || !data.teamId) return;
            const ds = state.director;
            const cfg = getQuestionConfig(state);
            const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ds.timer.remaining / ds.timer.total)) : 0;
            if (!ds.scores[data.teamId]) ds.scores[data.teamId] = 0;
            ds.scores[data.teamId] += cfg.basePoints + bonus;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:mark_wrong', (data) => {
            if (!data || !data.teamId) return;
            const ds = state.director;
            const cfg = getQuestionConfig(state);
            if (cfg.penalty > 0) {
                if (!ds.scores[data.teamId]) ds.scores[data.teamId] = 0;
                ds.scores[data.teamId] -= cfg.penalty;
            }
            const idx = state.colaPulsador.findIndex(p => p.id === data.teamId);
            if (idx > -1) state.colaPulsador.splice(idx, 1);
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:add_points', (data) => {
            if (!data || !data.teamId) return;
            const pts = Number(data.points);
            if (!isFinite(pts)) return;
            const ds = state.director;
            if (!ds.scores[data.teamId]) ds.scores[data.teamId] = 0;
            ds.scores[data.teamId] += pts;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:toggle_scoreboard', () => {
            state.director.scoreboardVisible = !state.director.scoreboardVisible;
            if (state.director.scoreboardVisible) state.director.qrVisible = false;
            broadcastDirector(io, gameId, state);
        });
        // Legacy: also support show_scoreboard as toggle
        socket.on('director:show_scoreboard', () => {
            state.director.scoreboardVisible = !state.director.scoreboardVisible;
            if (state.director.scoreboardVisible) state.director.qrVisible = false;
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:toggle_qr', () => {
            state.director.qrVisible = !state.director.qrVisible;
            if (state.director.qrVisible) state.director.scoreboardVisible = false;
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:show_waiting', () => { stopTimer(state, gameId, io); state.director.phase = 'waiting'; state.director.menuLevel = null; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; broadcastDirector(io, gameId, state); });
        socket.on('director:show_lobby', () => { stopTimer(state, gameId, io); state.director.phase = 'lobby'; state.director.menuLevel = null; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; broadcastDirector(io, gameId, state); });
        socket.on('director:show_home', () => { stopTimer(state, gameId, io); state.director.phase = 'lobby'; state.director.menuLevel = 'home'; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; broadcastDirector(io, gameId, state); });
        socket.on('director:select_category', (data) => { if (!data || !data.category) return; state.director.phase = 'lobby'; state.director.menuLevel = 'category'; state.director.selectedCategory = data.category; state.director.scoreboardVisible = false; state.director.qrVisible = false; broadcastDirector(io, gameId, state); });

        socket.on('director:block_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) { eq.bloqueado = true; io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos); if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) { eq.bloqueado = false; io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos); if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:block_all', () => {
            state.equipos.forEach(eq => { eq.bloqueado = true; if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); });
            state.bloqueoGlobal = true;
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_all', () => {
            state.equipos.forEach(eq => { eq.bloqueado = false; if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); });
            state.bloqueoGlobal = false;
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:rename_team', (data) => {
            if (!data || !data.teamId || !data.name) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) {
                eq.nombre = data.name.trim();
                db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(eq.nombre, eq.id);
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reveal_options', () => {
            const ds = state.director;
            ds.optionsRevealed = true;
            // Start 5-second pre-countdown before timer auto-starts
            ds.preCountdown = 5;
            broadcastDirector(io, gameId, state);
            state._preCountdownHandle = setInterval(() => {
                ds.preCountdown = Math.max(0, (ds.preCountdown || 0) - 1);
                if (ds.preCountdown <= 0) {
                    clearPreCountdown(state);
                    // Auto-start timer
                    if (!ds.timer.running && ds.timer.remaining > 0) {
                        ds.timer.running = true;
                        state._timerHandle = setInterval(() => {
                            ds.timer.remaining = Math.max(0, ds.timer.remaining - 1);
                            io.to(roomOf(gameId)).emit('game:timer_tick', { remaining: ds.timer.remaining, total: ds.timer.total });
                            if (ds.timer.remaining <= 0) {
                                stopTimer(state, gameId, io);
                                if (ds.phase === 'question') {
                                    if (ds.currentRound && ds.currentRound.type === 'multirespuesta') {
                                        autoScoreMultirespuesta(state);
                                    } else if (ds.currentRound && ds.currentRound.type === 'precio') {
                                        autoScorePrecio(state);
                                    } else if (ds.currentRound && ds.currentRound.type === 'identidad') {
                                        for (const [tid, ans] of Object.entries(ds.answers)) {
                                            if (!ans.submitted) {
                                                ans.submitted = true;
                                                ans.timerRemaining = 0;
                                            }
                                        }
                                        autoScoreIdentidad(state);
                                    } else if (ds.currentRound && ds.currentRound.type === 'boom') {
                                        autoScoreBoom(state);
                                    }
                                    ds.phase = 'answer_revealed';
                                    state.pulsadorActivo = false;
                                    computeLastQuestionScores(state);
                                }
                                broadcastDirector(io, gameId, state);
                            }
                        }, 1000);
                    }
                }
                broadcastDirector(io, gameId, state);
            }, 1000);
        });

        socket.on('director:toggle_team_results', () => {
            state.director.showTeamResults = !state.director.showTeamResults;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:complete_round', (data) => {
            if (!data || !data.roundId) return;
            const ds = state.director;
            if (ds.completedRounds.indexOf(data.roundId) === -1) {
                ds.completedRounds.push(data.roundId);
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:finish_round', () => {
            const ds = state.director;
            if (ds.currentRoundId && ds.completedRounds.indexOf(ds.currentRoundId) === -1) {
                ds.completedRounds.push(ds.currentRoundId);
            }
            stopTimer(state, gameId, io);
            ds.identidad = null;
            ds.optionsRevealed = false;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            ds.phase = 'round_end';
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:go_home', () => {
            const ds = state.director;
            ds.currentRoundId = null;
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
            ds.identidad = null;
            ds.phase = 'lobby';
            ds.menuLevel = 'home';
            ds.selectedCategory = null;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reset_session', () => {
            const ds = state.director;
            // Reset scores to 0
            Object.keys(ds.scores).forEach(k => { ds.scores[k] = 0; });
            // Reset completed rounds
            ds.completedRounds = [];
            // Reset round/question state
            ds.currentRoundId = null;
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.phase = 'lobby';
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
            ds.identidad = null;
            ds.optionsRevealed = false;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            stopTimer(state, gameId, io);
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            // Keep teams connected — don't touch state.equipos
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reset_full', () => {
            const ds = state.director;
            stopTimer(state, gameId, io);
            // Delete all teams from DB for this session
            if (state._sessionId) {
                db.prepare('DELETE FROM teams WHERE session_id = ?').run(state._sessionId);
            }
            // Reset all director state
            ds.scores = {};
            ds.completedRounds = [];
            ds.currentRoundId = null;
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.phase = 'lobby';
            ds.menuLevel = null;
            ds.selectedCategory = null;
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false };
            ds.identidad = null;
            ds.optionsRevealed = false;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            // Clear teams from memory
            state.equipos = [];
            state.juegoIniciado = false;
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            // Notify all players to reset their local state
            io.to(roomOf(gameId)).emit('game:reset_full');
            broadcastDirector(io, gameId, state);
        });

        // ─── Disconnect ───
        socket.on('disconnect', () => {
            if (!socket.equipoId) return;
            const equipo = state.equipos.find(e => e.id === socket.equipoId);
            if (equipo && equipo.socketId === socket.id) {
                equipo.ocupado = false;
                equipo.socketId = null;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                broadcastDirector(io, gameId, state);
            }
        });
    });
}

module.exports = { attachSocketHandlers, gameStates };
