// Handlers de Socket.io con aislamiento por gameId (rooms `game:<gameId>`).
// Migra 1:1 toda la lógica del prototipo (pulsador, precio justo, bloqueos, bonos, escenas) al esquema multi-juego.
// Cada juego tiene su propio GameState en memoria; el estado puede persistirse a SQLite en sesiones (fase posterior).

const { db, DEFAULT_GAME_ID } = require('../db');

// PIN del admin legacy. Se mantiene como variable global (no por juego) porque el flujo PIN del index.html
// no conoce gameIds — entra por defecto al juego 'default'. Los códigos de acceso por juego (spec §7.1)
// son otra cosa y se usarán cuando se construya la vista /play multi-juego.
const ADMIN_PIN = process.env.ADMIN_PIN || '6174';

// Estado en memoria por gameId. La BD persiste configuración (rondas/preguntas); el estado de la partida
// en curso vive aquí — es ephemeral por diseño (se quiere baja latencia y reset fácil).
const gameStates = new Map();

function createGameState() {
    return {
        juegoIniciado: false,
        equipos: [],
        // Modelo equipo: { id, nombre, ocupado, bonos: [], bloqueado: false, socketId }
        vistaActual: 'pulsador',           // 'pulsador' | 'espera' | 'web' | 'precio'
        urlActual: '',
        urlsGuardadas: ['', '', ''],
        escenas: { espera: 'espera.jpg' },
        pulsadorActivo: false,
        colaPulsador: [],
        bloqueoGlobal: false,
        precio: {
            tiempoSegundos: 30,
            tiempoInicio: null,
            respuestas: {},                // { equipoId: { valor, tiempo } }
            fase: 'config',                // 'config' | 'jugando' | 'resultado'
            ganadorId: null,
            cifraCorrecta: null            // expuesta SOLO en fase 'resultado'
        },
        // Director state (FASE 1 — vista coordinador)
        director: {
            phase: 'lobby',                // lobby | question | answer_revealed | scoreboard | waiting
            currentRoundId: null,
            currentRound: null,            // { id, name, type, config }
            questions: [],                 // [{ id, sort_order, content, media_url, config }]
            currentQuestionIdx: -1,
            timer: { total: 0, remaining: 0, running: false },
            scores: {},                    // { teamId: number }
            answers: {},                   // { teamId: { answer, timestamp } }
            revealedCells: [],             // [index] — para tipo imagen (cuadrícula)
            revealedLetters: [],           // [index] — para tipo ruleta (frase oculta)
        },
        // Privados al servidor — nunca se emiten en sync_estado:
        precioCifraCorrecta: null,
        precioTimeoutHandle: null,
        _timerHandle: null
    };
}

function getOrCreateState(gameId) {
    let s = gameStates.get(gameId);
    if (!s) {
        s = createGameState();
        s._gameTheme = loadGameTheme(gameId);
        gameStates.set(gameId, s);
    }
    return s;
}

// Vista emitible del estado: oculta cifra/timeoutHandle para que NO viajen a los clientes durante 'jugando'.
function publicView(state) {
    const { precioCifraCorrecta, precioTimeoutHandle, _timerHandle, _gameTheme, ...rest } = state;
    rest.gameTheme = _gameTheme || {};
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

function stopTimer(state, gameId, io) {
    if (state._timerHandle) { clearInterval(state._timerHandle); state._timerHandle = null; }
    state.director.timer.running = false;
}

// Vista sanitizada para jugadores: oculta respuestas correctas hasta reveal, no incluye todas las preguntas.
function loadGameTheme(gameId) {
    const row = db.prepare('SELECT theme FROM games WHERE id = ?').get(gameId);
    return row ? parseJson(row.theme) : {};
}

function playerView(state) {
    const ds = state.director;
    const curQ = ds.questions[ds.currentQuestionIdx];
    let question = null;
    if (curQ && (ds.phase === 'question' || ds.phase === 'answer_revealed')) {
        const c = { ...curQ.content };
        if (ds.phase === 'question') {
            delete c.correct; delete c.answer; delete c.correct_value; delete c.correct_order;
        }
        question = { id: curQ.id, content: c, media_url: curQ.media_url };
    }
    const roundCfg = ds.currentRound ? parseJson(ds.currentRound.config) : {};
    return {
        phase: ds.phase,
        roundType: ds.currentRound ? ds.currentRound.type : null,
        roundName: ds.currentRound ? ds.currentRound.name : null,
        question,
        questionIdx: ds.currentQuestionIdx,
        totalQuestions: ds.questions.length,
        timer: { total: ds.timer.total, remaining: ds.timer.remaining, running: ds.timer.running },
        scores: ds.scores,
        answeredTeams: Object.keys(ds.answers),
        equipos: state.equipos.map(e => ({ id: e.id, nombre: e.nombre, ocupado: e.ocupado, bloqueado: e.bloqueado })),
        pulsadorActivo: state.pulsadorActivo,
        colaPulsador: state.colaPulsador,
        bloqueoGlobal: state.bloqueoGlobal,
        revealedCells: ds.revealedCells,
        revealedLetters: ds.revealedLetters,
        gameTheme: state._gameTheme || {},
        roundTheme: { logo: roundCfg.logo || null, background: roundCfg.background || null },
    };
}

function broadcastDirector(io, gameId, state) {
    io.to(`directors:${gameId}`).emit('game:director_sync', publicView(state));
    io.to(roomOf(gameId)).emit('game:player_sync', playerView(state));
}

// Valida que el gameId existe en BD. Si no, cae a 'default' (suficiente para FASE 0).
function resolveGameId(requestedId) {
    if (!requestedId) return DEFAULT_GAME_ID;
    const row = db.prepare('SELECT id FROM games WHERE id = ?').get(requestedId);
    return row ? row.id : DEFAULT_GAME_ID;
}

function attachSocketHandlers(io) {
    io.on('connection', (socket) => {
        // Resolución del gameId: vía handshake (?gameId=X) o por defecto 'default'.
        // Las nuevas vistas (/director/:gameId, /screen/:gameId) lo pasarán explícitamente;
        // la app legacy (`/`) entra a 'default' sin tocar nada.
        const requested = socket.handshake.query && socket.handshake.query.gameId;
        const gameId = resolveGameId(requested);
        socket.gameId = gameId;
        socket.join(roomOf(gameId));

        const state = getOrCreateState(gameId);

        // Envía estado inicial sólo a este socket (no a la room).
        socket.emit('init_connection', {
            juegoIniciado: state.juegoIniciado,
            estadoJuego: publicView(state),
            equipos: state.equipos,
            gameId
        });

        // ─── Cierra la ronda actual de Precio Justo y emite resultado a la room. ───
        function finalizarPrecio() {
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.precio.fase = 'resultado';
            state.precio.cifraCorrecta = state.precioCifraCorrecta;

            const cifra = state.precioCifraCorrecta;
            // Descartar a quien se pasa; gana el más alto por debajo o exacto; desempate por timestamp.
            const ordenados = Object.entries(state.precio.respuestas)
                .filter(([, r]) => r.valor <= cifra)
                .sort((a, b) => {
                    if (b[1].valor !== a[1].valor) return b[1].valor - a[1].valor;
                    return a[1].tiempo - b[1].tiempo;
                });
            state.precio.ganadorId = ordenados.length > 0 ? ordenados[0][0] : null;

            io.to(roomOf(gameId)).emit('precio_resultado', {
                cifraCorrecta: cifra,
                respuestas: state.precio.respuestas,
                ganadorId: state.precio.ganadorId
            });
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        }

        // ═══════════════════════ ADMIN ═══════════════════════

        socket.on('login_admin', (pin) => {
            if (String(pin).trim() === ADMIN_PIN) {
                socket.isAdmin = true;
                socket.emit('admin_auth_success', {
                    equipos: state.equipos,
                    estadoJuego: publicView(state),
                    juegoIniciado: state.juegoIniciado,
                    precioCifra: state.precioCifraCorrecta,
                    gameId
                });
            } else {
                socket.emit('admin_auth_fail');
            }
        });

        socket.on('admin_crear_juego', (n) => {
            const total = Math.max(1, Math.min(20, Number(n) || 0));
            state.equipos = [];
            for (let i = 1; i <= total; i++) {
                state.equipos.push({
                    id: `eq${i}`, nombre: `Equipo ${i}`, ocupado: false,
                    bonos: [], bloqueado: false
                });
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
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            io.to(roomOf(gameId)).emit('juego_iniciado_teams', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_control_pulsador', (acc) => {
            if (acc === 'abrir')  state.pulsadorActivo = true;
            if (acc === 'pausar') state.pulsadorActivo = false;
            if (acc === 'reset')  { state.pulsadorActivo = false; state.colaPulsador = []; }
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', {
                activo: state.pulsadorActivo,
                cola: state.colaPulsador
            });
        });

        socket.on('admin_config_escenas', (data) => {
            state.escenas.espera = data.espera;
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
            if (state.vistaActual === 'espera') {
                io.to(roomOf(gameId)).emit('cambio_de_escena', publicView(state));
            }
        });

        socket.on('admin_set_escena', (d) => {
            state.vistaActual = d.vista;
            if (d.vista === 'web' && d.url) state.urlActual = d.url;
            if (d.saveSlot !== undefined && d.urlToSave) state.urlsGuardadas[d.saveSlot] = d.urlToSave;
            io.to(roomOf(gameId)).emit('cambio_de_escena', publicView(state));
        });

        // ─── Bonos y bloqueos ───
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

        // ─── Precio Justo (admin) ───
        socket.on('admin_precio_set_cifra', (valor) => {
            const n = Number(valor);
            if (!isFinite(n)) return;
            state.precioCifraCorrecta = n;
            // Echo sólo al admin que la set para retrocompatibilidad. Cuando llegue multi-admin (FASE 1)
            // se sincronizará a todos los admins de la misma room.
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
            if (state.precio.respuestas[eq.id]) return; // una respuesta por ronda
            state.precio.respuestas[eq.id] = { valor, tiempo: Date.now() };
            io.to(roomOf(gameId)).emit('sync_estado', publicView(state));
        });

        // ═══════════════════════ JUGADORES ═══════════════════════

        socket.on('join_team', (data) => {
            const equipo = state.equipos.find(e => e.id === data.id);
            if (!equipo) return;

            // Si otro socket vivo ya tiene el equipo, rechazar. Si el anterior está muerto, permitir takeover.
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

            socket.emit('login_success', {
                miEquipo: equipo,
                estado: publicView(state),
                equiposRivales: state.equipos
            });
            socket.emit('game:player_sync', playerView(state));
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('pulsar_boton', () => {
            const e = state.equipos.find(x => x.id === socket.equipoId);
            if (!e) return;
            if (!state.pulsadorActivo || state.bloqueoGlobal || e.bloqueado) return;
            if (state.colaPulsador.find(p => p.id === e.id)) return;
            state.colaPulsador.push({ id: e.id, nombre: e.nombre, tiempo: Date.now() });
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            broadcastDirector(io, gameId, state);
        });

        // ─── Respuestas de jugador en flujo director (FASE 2) ───
        socket.on('player:submit_answer', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            ds.answers[socket.equipoId] = {
                answer: data.answer,
                timestamp: Date.now(),
                timerRemaining: ds.timer.remaining
            };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_price', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            const val = Number(data && data.value);
            if (!isFinite(val)) return;
            ds.answers[socket.equipoId] = {
                answer: val,
                timestamp: Date.now(),
                timerRemaining: ds.timer.remaining
            };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_order', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            if (!Array.isArray(data.order)) return;
            ds.answers[socket.equipoId] = {
                answer: data.order,
                timestamp: Date.now(),
                timerRemaining: ds.timer.remaining
            };
            broadcastDirector(io, gameId, state);
        });

        socket.on('usar_bono', (data) => {
            const emisor = state.equipos.find(e => e.id === socket.equipoId);
            if (!emisor || !emisor.bonos.includes(data.tipo)) return;

            let mensaje = '';
            if (data.tipo === 'lock_all') {
                state.equipos.forEach(eq => {
                    if (eq.id !== emisor.id) {
                        eq.bloqueado = true;
                        if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
                    }
                });
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                mensaje = `⛔ ${emisor.nombre} BLOQUEÓ A RIVALES`;
            } else if (data.tipo === 'freeze') {
                let victima = state.equipos.find(e => e.id === data.targetId);
                if (!victima && data.targetNumero) victima = state.equipos.find(e => e.id === `eq${data.targetNumero}`);
                if (!victima) {
                    socket.emit('notificacion_bono', { msg: '❌ Equipo no encontrado' });
                    return;
                }
                if (victima.id === emisor.id) {
                    socket.emit('notificacion_bono', { msg: '❌ No te puedes congelar a ti mismo' });
                    return;
                }
                victima.bloqueado = true;
                mensaje = `❄️ ${emisor.nombre} CONGELÓ A ${victima.nombre}`;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (victima.socketId) io.to(victima.socketId).emit('update_mi_equipo', victima);
            }

            const idx = emisor.bonos.indexOf(data.tipo);
            if (idx > -1) emisor.bonos.splice(idx, 1);
            socket.emit('update_mi_equipo', emisor);
            io.to(roomOf(gameId)).emit('notificacion_bono', { msg: mensaje });
        });

        // ═══════════════════════ DIRECTOR (FASE 1 bloque B) ═══════════════════════

        socket.on('director:join', () => {
            socket.isDirector = true;
            socket.join(`directors:${gameId}`);
            socket.emit('game:director_sync', publicView(state));
        });

        socket.on('screen:join', () => {
            socket.emit('game:player_sync', playerView(state));
        });

        socket.on('director:refresh_theme', () => {
            state._gameTheme = loadGameTheme(gameId);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:create_teams', (data) => {
            const count = Math.max(1, Math.min(20, Number(data && data.count) || 0));
            state.equipos = [];
            state.director.scores = {};
            for (let i = 1; i <= count; i++) {
                const id = `eq${i}`;
                state.equipos.push({ id, nombre: `Equipo ${i}`, ocupado: false, bonos: [], bloqueado: false });
                state.director.scores[id] = 0;
            }
            state.juegoIniciado = true;
            state.colaPulsador = [];
            state.bloqueoGlobal = false;
            state.pulsadorActivo = false;
            io.to(roomOf(gameId)).emit('juego_iniciado_teams', state.equipos);
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
            ds.phase = 'lobby';
            ds.answers = {};
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            broadcastDirector(io, gameId, state);
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
            const cfg = getQuestionConfig(state);
            ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
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
                const cfg = getQuestionConfig(state);
                ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
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
                const cfg = getQuestionConfig(state);
                ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:start_timer', () => {
            const ds = state.director;
            if (ds.timer.running || ds.timer.remaining <= 0) return;
            ds.timer.running = true;
            state._timerHandle = setInterval(() => {
                ds.timer.remaining = Math.max(0, ds.timer.remaining - 1);
                io.to(roomOf(gameId)).emit('game:timer_tick', { remaining: ds.timer.remaining, total: ds.timer.total });
                if (ds.timer.remaining <= 0) {
                    stopTimer(state, gameId, io);
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

            // Auto-score multirespuesta: compara respuestas de cada equipo contra las correctas.
            if (ds.currentRound && ds.currentRound.type === 'multirespuesta') {
                const q = ds.questions[ds.currentQuestionIdx];
                if (q && q.content && q.content.correct !== undefined) {
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
            }

            ds.phase = 'answer_revealed';
            state.pulsadorActivo = false;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:open_buzzer', () => {
            state.pulsadorActivo = true;
            state.colaPulsador = [];
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

        // ─── Imagen: revelar celda de la cuadrícula ───
        socket.on('director:reveal_cell', (data) => {
            const ds = state.director;
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0) return;
            if (ds.revealedCells.indexOf(idx) === -1) {
                ds.revealedCells.push(idx);
                broadcastDirector(io, gameId, state);
            }
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

        // ─── Ruleta: revelar letra de la frase oculta ───
        socket.on('director:reveal_letter', (data) => {
            const ds = state.director;
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0) return;
            if (ds.revealedLetters.indexOf(idx) === -1) {
                ds.revealedLetters.push(idx);
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:reveal_all_letters', () => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const phrase = (q.content && q.content.phrase) || '';
            ds.revealedLetters = [];
            for (let i = 0; i < phrase.length; i++) ds.revealedLetters.push(i);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:mark_correct', (data) => {
            if (!data || !data.teamId) return;
            const ds = state.director;
            const cfg = getQuestionConfig(state);
            const bonus = ds.timer.total > 0 ? Math.floor(cfg.bonusMax * (ds.timer.remaining / ds.timer.total)) : 0;
            const points = cfg.basePoints + bonus;
            if (!ds.scores[data.teamId]) ds.scores[data.teamId] = 0;
            ds.scores[data.teamId] += points;
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
            // Bounce: remove from buzzer queue
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

        socket.on('director:show_scoreboard', () => {
            stopTimer(state, gameId, io);
            state.director.phase = 'scoreboard';
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:show_waiting', () => {
            stopTimer(state, gameId, io);
            state.director.phase = 'waiting';
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:show_lobby', () => {
            stopTimer(state, gameId, io);
            state.director.phase = 'lobby';
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:block_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) {
                eq.bloqueado = true;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) {
                eq.bloqueado = false;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:block_all', () => {
            state.equipos.forEach(eq => {
                eq.bloqueado = true;
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            });
            state.bloqueoGlobal = true;
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_all', () => {
            state.equipos.forEach(eq => {
                eq.bloqueado = false;
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            });
            state.bloqueoGlobal = false;
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:rename_team', (data) => {
            if (!data || !data.teamId || !data.name) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) {
                eq.nombre = data.name.trim();
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            }
            broadcastDirector(io, gameId, state);
        });

        // ─── Reconexión / desconexión ───
        socket.on('disconnect', () => {
            if (!socket.equipoId) return;
            const equipo = state.equipos.find(e => e.id === socket.equipoId);
            // Sólo liberar si este socket sigue siendo el dueño (evita pisar takeover ya hecho).
            if (equipo && equipo.socketId === socket.id) {
                equipo.ocupado = false;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            }
        });
    });
}

module.exports = { attachSocketHandlers, gameStates };
