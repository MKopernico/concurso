// Handlers de Socket.io con aislamiento por gameId (rooms `game:<gameId>`).
// Cada juego tiene su propio GameState en memoria; equipos se persisten en SQLite via sessions/teams.

const { db, DEFAULT_GAME_ID } = require('../db');

const auth = require('../auth');
const QV = require('../public/shared/question-validation.js');

const gameStates = new Map();

// Crea un equipo en memoria. deviceId (identidad secreta del iPad) y socketId no son
// enumerables: siguen accesibles en el servidor pero no viajan en ningún emit, así que
// nadie puede copiarlos para suplantar a otro equipo.
function team(obj) {
    const { deviceId = null, socketId = null, ...rest } = obj;
    Object.defineProperty(rest, 'deviceId', { value: deviceId, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(rest, 'socketId', { value: socketId, writable: true, enumerable: false, configurable: true });
    return rest;
}

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
            bonoLog: [],
            optionsRevealed: false,
            lastQuestionScores: {},
            showTeamResults: false,
            scoreboardVisible: false,
            qrVisible: false,
            screensPreload: {},     // socketId de pantalla → resumen de su precarga
            premioAnuncioVisible: false,
            premioGanadorVisible: false,
            premioGanadorTeam: null,
            premioGanadorTipo: null,
        },
        precioCifraCorrecta: null,
        precioTimeoutHandle: null,
        _timerHandle: null,
        _sessionId: null,
    };
}

// Modo sin pantalla y dónde suena: el backoffice da el valor de partida (tema del juego) y el
// coordinador lo puede cambiar en directo (ds.noScreen / ds.audioOn).
function applyScreenDefaults(s) {
    const t = s._gameTheme || {};
    s.director.noScreen = !!t.noScreen;
    s.director.audioOn = t.audio === 'ipads' ? 'ipads' : 'sala';
}

function getOrCreateState(gameId) {
    let s = gameStates.get(gameId);
    if (!s) {
        s = createGameState();
        s._gameTheme = loadGameTheme(gameId);
        applyScreenDefaults(s);
        s._rounds = db.prepare('SELECT id, name, type, config FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId);
        // Load teams from active session in DB
        const session = db.prepare('SELECT id, state FROM sessions WHERE game_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(gameId);
        if (session) {
            s._sessionId = session.id;
            const dbTeams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
            s.equipos = dbTeams.map(t => team({
                id: t.id, nombre: t.name, photo_url: t.photo_url,
                ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: t.device_id
            }));
            s.director.scores = {};
            s.equipos.forEach(e => { s.director.scores[e.id] = 0; });
            if (s.equipos.length > 0) s.juegoIniciado = true;
            restoreSnapshot(s, session.state);
        }
        s._gameId = gameId;
        gameStates.set(gameId, s);
    }
    return s;
}

// ───────────────── Persistencia del marcador ─────────────────
// Puntos, bonos, congelaciones, rondas jugadas y log de bonos se guardan en sessions.state
// (cada 2 s si han cambiado, y al apagar el servidor) para que un reinicio no los pierda.

function snapshotOf(state) {
    const ds = state.director;
    return JSON.stringify({
        v: 1,
        scores: ds.scores,
        completedRounds: ds.completedRounds,
        bonoLog: ds.bonoLog,
        questionResults: ds.questionResults || {},
        bloqueoGlobal: !!state.bloqueoGlobal,
        noScreen: !!ds.noScreen,
        audioOn: ds.audioOn || 'sala',
        pendingScores: ds.pendingScores || null,
        abiertaWip: ds.abiertaWip || {}, // respuestas abiertas a medio corregir
        pic: { done: ds.picDone || [], rank: ds.picRank || {}, last: ds.picLast || null }, // rueda de turnos del Pictionary
        teams: Object.fromEntries(state.equipos.map(e => [e.id, { bonos: e.bonos || [], bloqueado: !!e.bloqueado, descongelaEn: e.descongelaEn || 0 }])),
    });
}

function restoreSnapshot(s, json) {
    if (!json) return;
    let snap;
    try { snap = JSON.parse(json); } catch { return; }
    if (!snap || snap.v !== 1) return;
    s.equipos.forEach(e => {
        if (snap.scores && typeof snap.scores[e.id] === 'number') s.director.scores[e.id] = snap.scores[e.id];
        const t = snap.teams && snap.teams[e.id];
        if (t) { e.bonos = Array.isArray(t.bonos) ? t.bonos : []; e.bloqueado = !!t.bloqueado; e.descongelaEn = t.descongelaEn || 0; }
    });
    s.director.completedRounds = Array.isArray(snap.completedRounds) ? snap.completedRounds : [];
    s.director.bonoLog = Array.isArray(snap.bonoLog) ? snap.bonoLog : [];
    s.director.questionResults = (snap.questionResults && typeof snap.questionResults === 'object') ? snap.questionResults : {};
    s.bloqueoGlobal = !!snap.bloqueoGlobal;
    if (typeof snap.noScreen === 'boolean') s.director.noScreen = snap.noScreen;
    if (snap.audioOn === 'ipads' || snap.audioOn === 'sala') s.director.audioOn = snap.audioOn;
    if (snap.pendingScores && typeof snap.pendingScores === 'object') s.director.pendingScores = snap.pendingScores;
    if (snap.abiertaWip && typeof snap.abiertaWip === 'object') s.director.abiertaWip = snap.abiertaWip;
    if (snap.pic && typeof snap.pic === 'object') {
        s.director.picDone = Array.isArray(snap.pic.done) ? snap.pic.done : [];
        s.director.picRank = (snap.pic.rank && typeof snap.pic.rank === 'object') ? snap.pic.rank : {};
        s.director.picLast = snap.pic.last || null;
    }
    s._lastSnapshot = json;
}

function persistState(s) {
    if (!s._sessionId) return;
    const json = snapshotOf(s);
    if (json === s._lastSnapshot) return;
    try {
        db.prepare('UPDATE sessions SET state = ? WHERE id = ? AND ended_at IS NULL').run(json, s._sessionId);
        s._lastSnapshot = json;
    } catch (e) { console.error('[persist]', e.message); }
}

function persistAll() { for (const s of gameStates.values()) persistState(s); }

setInterval(persistAll, 2000).unref();
// Al apagar (Render, Ctrl+C, cerrar la ventana del kit): guardar marcador y cerrar la BD limpia
['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'].forEach(sig => {
    try { process.once(sig, () => { persistAll(); require('../db').closeDb(); process.exit(0); }); } catch (e) { /* señal no disponible */ }
});

// Nueva partida en un juego ya cargado: se reinicia el estado EN SU SITIO (los sockets
// conectados guardan una referencia a este objeto) y se avisa a todos los dispositivos.
let _io = null;
function resetGameForNewSession(gameId, sessionId) {
    const s = gameStates.get(gameId);
    if (!s) return; // nadie conectado: se cargará limpio al conectar
    if (s.precioTimeoutHandle) clearTimeout(s.precioTimeoutHandle);
    clearPreCountdown(s);
    if (s._timerHandle) clearInterval(s._timerHandle);
    const fresh = createGameState();
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, fresh, {
        _gameId: gameId,
        _sessionId: sessionId,
        _gameTheme: loadGameTheme(gameId),
        _rounds: db.prepare('SELECT id, name, type, config FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId),
    });
    applyScreenDefaults(s);
    if (_io) {
        _io.to(roomOf(gameId)).emit('game:reset_full');
        broadcastDirector(_io, gameId, s);
    }
}

// Rondas cambiadas en el backoffice (orden de la escaleta, nuevas, borradas…): menús de pantalla
// e iPads al día y los coordinadores recargan su barra de rondas. La pregunta en curso no se toca.
function roundsChanged(gameId) {
    const s = gameStates.get(gameId);
    if (s) s._rounds = db.prepare('SELECT id, name, type, config FROM rounds WHERE game_id = ? ORDER BY sort_order, id').all(gameId);
    if (!_io) return;
    _io.to(`directors:${gameId}`).emit('game:rounds_changed');
    if (s) broadcastDirector(_io, gameId, s);
}

function publicView(state) {
    const { precioCifraCorrecta, precioTimeoutHandle, _timerHandle, _preCountdownHandle, _gameTheme, _sessionId, _rounds, _lastSnapshot, _gameId, _recovery, _tickAt, _ticks, _pic, _picDrawings, _padSocketId, ...rest } = state;
    rest.gameTheme = _gameTheme || {};
    // questionResults (respuestas de todas las preguntas ya jugadas) solo sirve al servidor para
    // no volver a puntuar: crece ~3,5 KB por pregunta y no lo usa ninguna pantalla. Enviarlo en
    // cada actualización hacía que, tras cientos de preguntas, todo fuera cada vez más lento.
    // El registro tampoco viaja entero en cada actualización (puede tener cientos de entradas):
    // solo el contador y las 5 últimas; el panel lo pide completo con 'director:get_log'.
    const { questionResults, bonoLog, abiertaWip, ...ds } = rest.director || {};
    rest.director = ds;
    const log = Array.isArray(bonoLog) ? bonoLog : [];
    ds.logCount = typeof ds.logCount === 'number' ? ds.logCount : log.length;
    ds.bonoLog = log.slice(-5);
    if (ds.aclara) ds.aclara = aclaraView(state.director); // nitidez calculada ahora (el reloj del iPad puede ir distinto)
    if (ds && ds.answers) {
        ds.answeredCount = Object.values(ds.answers).filter(a => a.submitted !== false).length;
    }
    return rest;
}

function roomOf(gameId) { return `game:${gameId}`; }

// Resumen de precarga que envía cada dispositivo (ver shared/asset-preloader.js summary()).
function cleanPreloadStatus(d) {
    d = d || {};
    const n = (v) => Math.max(0, Math.min(100000, Number(v) || 0));
    return {
        total: n(d.total), ok: n(d.ok), failed: n(d.failed), missing: n(d.missing),
        names: Array.isArray(d.names) ? d.names.slice(0, 20).map(s => String(s).slice(0, 80)) : [],
        skipped: !!d.skipped,
        at: Date.now(),
    };
}

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
        // Respuesta abierta: la cuenta atrás es de la pregunta y es opcional (0 = sin cuenta atrás)
        time: (ds.currentRound && ds.currentRound.type === 'abierta') ? abiertaTime(q)
            : (ds.currentRound && ds.currentRound.type === 'pictionary') ? picTimeOf(ds) // 0 = sin tiempo
            : (qCfg.time || rCfg.time || 30),
        basePoints: qCfg.basePoints ?? rCfg.basePoints ?? 100,
        bonusMax: qCfg.bonusMax ?? rCfg.bonusMax ?? 50,
        penalty: qCfg.penalty ?? rCfg.penalty ?? 0,
    };
}

// ── Imagen que se aclara ──
// ds.aclara = { level (0-1 al empezar el tramo actual), running, since (ms), rate (nitidez por segundo) }.
// La nitidez avanza sola en modo automático; al pulsar alguien se congela y un fallo la reanuda.
function initAclaraState(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    if (ds.currentRound && ds.currentRound.type === 'aclara' && q) {
        const dur = Math.max(5, Math.min(600, Number(q.content && q.content.duration) || 30));
        ds.aclara = { level: 0, running: false, since: 0, rate: 1 / dur };
    } else {
        ds.aclara = null;
    }
}
function aclaraLevel(ds) {
    const a = ds.aclara;
    if (!a) return 0;
    if (!a.running) return Math.min(1, a.level);
    return Math.min(1, a.level + (Date.now() - a.since) / 1000 * a.rate);
}
function aclaraPause(ds) {
    const a = ds.aclara;
    if (!a) return;
    a.level = aclaraLevel(ds); a.running = false;
}
function aclaraMode(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    return (q && q.content && q.content.mode === 'manual') ? 'manual' : 'auto';
}
// Puntos según lo nítida que estaba al pulsar: todos con la imagen irreconocible, un 20 % con
// la imagen casi nítida. Redondeado a 5.
function aclaraPoints(basePoints, level) {
    const pts = Math.max(basePoints * 0.2, basePoints * (1 - Math.max(0, Math.min(1, level))));
    return Math.round(pts / 5) * 5;
}
function aclaraView(ds) {
    if (!ds.aclara) return null;
    const lvl = aclaraLevel(ds);
    return { level: lvl, running: ds.aclara.running && lvl < 1, rate: ds.aclara.rate };
}

// ── Pictionary ──
// Cada pregunta es una palabra (content = { word, category? }). Config de la ronda:
//   picMode 'equipos' (dibuja un equipo en su iPad; los demás pulsan) | 'ipad' (dibuja una pizarra
//   fija enlazada por QR; pulsan todos y quien dibuja no suma), picTurns 'auto' (el servidor propone
//   a quién le toca) | 'manual' (lo elige el coordinador), picDrawerPoints: puntos para el equipo
//   que dibuja cuando alguien acierta (0 = nada). El tiempo (0 = sin tiempo) se para mientras
//   responde quien ha pulsado.
// ds.pictionary = { step: 'setup' (aún sin la palabra) | 'drawing', mode, drawer, drawerPts, pausedByBuzz }
// Los trazos no van en el estado general (se envía entero con cada cambio): viven en state._pic
// y viajan aparte (pic:chunk / pic:op / pic:full) solo a pantallas y coordinadores.
const PIC_MAX_POINTS = 150000;   // números (x,y) por dibujo: de sobra para un minuto dibujando
const PIC_MAX_CHUNK = 400;
const PIC_ARCHIVE = 60;          // dibujos de preguntas ya jugadas que se recuerdan (para volver a verlas)
function picCfg(ds) {
    const rc = ds.currentRound ? parseJson(ds.currentRound.config) : {};
    return {
        mode: rc.picMode === 'ipad' ? 'ipad' : 'equipos',
        turns: rc.picTurns === 'manual' ? 'manual' : 'auto',
        drawerPoints: Math.max(0, Math.round(Number(rc.picDrawerPoints) || 0)),
    };
}
function picTimeOf(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    const qt = Number(q && q.config && q.config.time);
    if (isFinite(qt) && qt > 0) return Math.min(600, Math.round(qt));
    const rt = Number(ds.currentRound ? parseJson(ds.currentRound.config).time : NaN);
    return isFinite(rt) && rt >= 0 ? Math.min(600, Math.round(rt)) : 60;
}
function questionKeyOf(ds) { return (ds.currentRoundId || '') + ':' + ds.currentQuestionIdx + ':' + (ds.questionEpoch || 0); }
// Pizarra de la pregunta en curso (null si la pregunta ya no es la suya)
function picBoard(state) {
    const b = state._pic;
    return b && b.key === questionKeyOf(state.director) ? b : null;
}
// Turnos automáticos: dibujan todos los equipos (en un orden al azar) antes de que nadie repita;
// al completar la vuelta se baraja otra (sin que repita justo el último). Los que entran a mitad
// de vuelta también tienen su turno. Entre los pendientes se propone primero uno conectado y sin congelar.
function picCandidate(state) {
    const ds = state.director;
    const teams = state.equipos;
    if (!teams.length) return null;
    if (!ds.picRank || typeof ds.picRank !== 'object') ds.picRank = {};
    if (!Array.isArray(ds.picDone)) ds.picDone = [];
    teams.forEach(e => { if (typeof ds.picRank[e.id] !== 'number') ds.picRank[e.id] = Math.random(); });
    let pending = teams.filter(e => !ds.picDone.includes(e.id));
    if (!pending.length) {
        ds.picDone = [];
        teams.forEach(e => { ds.picRank[e.id] = Math.random(); });
        if (teams.length > 1 && ds.picLast) ds.picRank[ds.picLast] = 2; // el último de la vuelta anterior, al final
        pending = teams.slice();
    }
    pending.sort((a, b) => ds.picRank[a.id] - ds.picRank[b.id]);
    const ready = pending.find(e => e.ocupado && !e.bloqueado);
    return (ready || pending[0]).id;
}
function picMarkDrawn(state, teamId) {
    const ds = state.director;
    if (!Array.isArray(ds.picDone)) ds.picDone = [];
    // Ya habían dibujado todos (p. ej. turnos elegidos a mano): este empieza la vuelta nueva
    if (state.equipos.length && state.equipos.every(e => ds.picDone.includes(e.id))) {
        ds.picDone = [];
        state.equipos.forEach(e => { if (!ds.picRank) ds.picRank = {}; ds.picRank[e.id] = Math.random(); });
    }
    if (!ds.picDone.includes(teamId)) ds.picDone.push(teamId);
    ds.picLast = teamId;
}
function initPictionaryState(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!(ds.currentRound && ds.currentRound.type === 'pictionary' && q)) { ds.pictionary = null; return; }
    const cfg = picCfg(ds);
    ds.pictionary = {
        step: 'setup', mode: cfg.mode, drawerPts: 0, pausedByBuzz: false,
        drawer: cfg.mode === 'equipos' && cfg.turns === 'auto' ? picCandidate(state) : null,
    };
    state._pic = { key: questionKeyOf(ds), qid: q.id, seq: 0, strokes: [], size: 0 };
}
// Al revelar se guarda el dibujo: volver a la pregunta lo enseña tal cual quedó
function picArchive(state) {
    const b = picBoard(state);
    if (!b || !b.strokes.length) return;
    if (!state._picDrawings) state._picDrawings = new Map();
    state._picDrawings.delete(b.qid);
    state._picDrawings.set(b.qid, b.strokes);
    while (state._picDrawings.size > PIC_ARCHIVE) state._picDrawings.delete(state._picDrawings.keys().next().value);
}
// Socket que dibuja ahora (el iPad del equipo o la pizarra fija), o null
function picDrawerSocket(state) {
    const p = state.director.pictionary;
    if (!p || !_io) return null;
    let sid = null;
    if (p.mode === 'ipad') sid = state._padSocketId;
    else { const e = state.equipos.find(x => x.id === p.drawer); sid = e && e.socketId; }
    return sid ? _io.sockets.sockets.get(sid) || null : null;
}
// La palabra solo viaja al que dibuja (y al coordinador, que tiene las preguntas)
function sendPicWord(socket, state) {
    const ds = state.director, p = ds.pictionary;
    if (!socket || !p || ds.phase !== 'question' || p.step !== 'drawing') return;
    const q = ds.questions[ds.currentQuestionIdx];
    const c = (q && q.content) || {};
    socket.emit('pic:word', { k: questionKeyOf(ds), word: String(c.word || ''), category: String(c.category || '') });
}
function picDrawerName(state) {
    const p = state.director.pictionary;
    return p && p.drawer ? teamName(state, p.drawer) : null;
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

// ── Respuesta abierta ──
// ds.abierta = { step, marks, revealStep, points, winner }
//   step: 'intro' (solo el enunciado general) → 'shown' (se ven las subpreguntas, aún sin escribir)
//         → 'open' (los equipos escriben) → 'correcting' (control corrige) → 'revealed'
//   marks: { teamId: [true|false por subpregunta] } — lo que coincide con una respuesta válida sale
//          ya en verde; el resto en rojo para que control lo valide a mano.
//   points: { teamId: puntos de esta pregunta } (proporcional a los aciertos + bonus al ganador)
// Las respuestas viven en ds.answers[teamId] = { answer: [textos], submitted, timestamp }.
function abiertaTime(q) {
    const t = Number(q && q.content && q.content.time);
    return isFinite(t) && t > 0 ? Math.min(3600, Math.round(t)) : 0;
}
function abiertaSubs(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    return (q && q.content && Array.isArray(q.content.subs)) ? q.content.subs : [];
}
function initAbiertaState(ds) {
    const q = ds.questions[ds.currentQuestionIdx];
    if (!(ds.currentRound && ds.currentRound.type === 'abierta' && q)) { ds.abierta = null; return; }
    // Pregunta que se dejó a medio corregir: se recupera tal cual (respuestas y correcciones)
    const wip = ds.abiertaWip && ds.abiertaWip[q.id];
    if (wip && wip.abierta && !(ds.questionResults && ds.questionResults[q.id])) {
        ds.answers = wip.answers || {};
        ds.abierta = wip.abierta;
        ds.optionsRevealed = true;
        return;
    }
    ds.abierta = { step: 'intro', marks: {}, revealStep: 0, points: null, winner: null };
}
// Cierra el tiempo de respuesta: lo escrito sin enviar cuenta como enviado al cerrar (pierde
// cualquier desempate), se corrige solo lo que coincide y empieza la corrección.
function closeAbierta(state) {
    const ds = state.director;
    const a = ds.abierta;
    if (!a || a.step === 'correcting' || a.step === 'revealed') return false;
    stopTimer(state);
    const now = Date.now();
    const subs = abiertaSubs(ds);
    for (const [tid, ans] of Object.entries(ds.answers)) {
        const texts = Array.isArray(ans.answer) ? ans.answer : [];
        if (!ans.submitted) {
            if (!texts.some(t => String(t || '').trim())) { delete ds.answers[tid]; continue; } // nada escrito
            ans.submitted = true; ans.timestamp = now; ans.timerRemaining = 0; ans.late = true;
        }
        a.marks[tid] = subs.map((s, i) => QV.matchesSub(texts[i], s));
    }
    a.step = 'correcting';
    a.closedAt = now;
    const q = ds.questions[ds.currentQuestionIdx];
    if (q) { if (!ds.abiertaWip) ds.abiertaWip = {}; ds.abiertaWip[q.id] = { answers: ds.answers, abierta: a }; }
    logAction(state, { action: 'abierta_closed', answered: Object.keys(ds.answers).length, total: state.equipos.length });
    return true;
}
// Puntos de cada equipo: puntos base × aciertos ÷ subpreguntas (redondeado). El que más acierta
// gana además el bonus de la pregunta; con empate, el que envió antes.
function abiertaResults(state) {
    const ds = state.director;
    const a = ds.abierta || {};
    const n = abiertaSubs(ds).length;
    const cfg = getQuestionConfig(state);
    const res = {};
    let winner = null;
    for (const [tid, ans] of Object.entries(ds.answers)) {
        if (!ans.submitted) continue;
        const marks = ((a.marks || {})[tid] || []).slice(0, n);
        const cc = marks.filter(Boolean).length;
        res[tid] = { correctCount: cc, points: n ? Math.round(cfg.basePoints * cc / n) : 0 };
        if (cc > 0) {
            const w = winner && res[winner];
            if (!w || cc > w.correctCount || (cc === w.correctCount && (ans.timestamp || 0) < (ds.answers[winner].timestamp || 0))) winner = tid;
        }
    }
    if (winner && cfg.bonusMax > 0) res[winner].points += cfg.bonusMax;
    return { res, winner };
}
// Al revelar: los puntos esperan (como en Boom e Identidad) hasta destapar la última subpregunta
function scoreAbierta(state) {
    const ds = state.director;
    const a = ds.abierta;
    const { res, winner } = abiertaResults(state);
    a.points = {};
    for (const [tid, r] of Object.entries(res)) { a.points[tid] = r.points; if (r.points) addPending(ds, tid, r.points); }
    a.winner = winner;
}
// Rectificar una corrección con la respuesta ya revelada: se recalcula la pregunta entera
// (también quién gana) y al marcador solo va la diferencia.
function rectifyAbierta(state, teamIds, subIdx, ok) {
    const ds = state.director;
    const a = ds.abierta;
    const old = a.points || {};
    const { res, winner } = abiertaResults(state);
    const neu = {};
    for (const [tid, r] of Object.entries(res)) neu[tid] = r.points;
    const changes = [];
    for (const tid of new Set([...Object.keys(old), ...Object.keys(neu)])) {
        const d = (neu[tid] || 0) - (old[tid] || 0);
        if (d) changes.push({ team: teamName(state, tid), pts: d, tid });
    }
    if (ds.pendingScores) {
        ds.pendingScores = {}; // aún sin sumar (revelando): se sustituyen
        for (const [tid, p] of Object.entries(neu)) if (p) ds.pendingScores[tid] = p;
    } else {
        for (const ch of changes) { if (!ds.scores[ch.tid]) ds.scores[ch.tid] = 0; ds.scores[ch.tid] += ch.pts; }
    }
    a.points = neu;
    a.winner = winner;
    computeLastQuestionScores(state);
    const q = ds.questions[ds.currentQuestionIdx];
    if (q && ds.questionResults && ds.questionResults[q.id]) ds.questionResults[q.id].lastQuestionScores = ds.lastQuestionScores;
    logAction(state, { action: 'abierta_fix', teams: teamIds.map(t => teamName(state, t)), sub: subIdx + 1, ok,
        changes: changes.map(ch => ({ team: ch.team, pts: ch.pts })), pending: !!ds.pendingScores });
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

// Al pasar a 'Espera' u 'Home' con una pregunta en curso, se recuerda para poder volver
function rememberResume(state) {
    const ds = state.director;
    if (ds.phase === 'question' || ds.phase === 'answer_revealed') ds.resumePhase = ds.phase;
}

// Pruebas sin temporizador (el coordinador las cierra a mano)
const NO_TIMER_TYPES = new Set(['pulsador', 'imagen', 'karaoke', 'ruleta', 'imagen_fija', 'cancion', 'aclara']);
// Registro de acciones del coordinador y de los bonos (ds.bonoLog, se guarda con la partida).
// Cada entrada lleva la hora y en qué ronda/pregunta ocurrió; se conservan las 1000 últimas.
const LOG_MAX = 1000;
function logAction(state, entry) {
    const ds = state.director;
    if (!Array.isArray(ds.bonoLog)) ds.bonoLog = [];
    if (typeof ds.logCount !== 'number') ds.logCount = ds.bonoLog.length;
    ds.logCount++; // total de entradas (para el aviso de «no vistas» del coordinador)
    entry.ts = Date.now();
    if (ds.currentRound && entry.action !== 'reset') entry.ctx = ds.currentRound.name + (ds.currentQuestionIdx >= 0 ? ' · P' + (ds.currentQuestionIdx + 1) : '');
    ds.bonoLog.push(entry);
    if (ds.bonoLog.length > LOG_MAX) ds.bonoLog.splice(0, ds.bonoLog.length - LOG_MAX);
}
function teamName(state, id) { const e = state.equipos.find(x => x.id === id); return e ? e.nombre : '?'; }

function isNoTimerRound(ds) {
    if (ds.currentRound && ds.currentRound.type === 'abierta') return !abiertaTime(ds.questions[ds.currentQuestionIdx]);
    if (ds.currentRound && ds.currentRound.type === 'pictionary') return !picTimeOf(ds);
    return !!(ds.currentRound && NO_TIMER_TYPES.has(ds.currentRound.type));
}

// Cierra la pregunta en curso: puntúa automáticamente según el tipo, revela y guarda el
// resultado. Si la pregunta ya no está en fase 'question' no hace nada (nunca puntúa dos veces).
// Respuesta abierta va en dos pasos: la primera vez (fin del tiempo, «Revelar» con los equipos
// escribiendo) solo cierra las respuestas y empieza la corrección; ya corregida, revela.
function finalizeQuestion(state) {
    const ds = state.director;
    if (ds.phase !== 'question') return false;
    const type = ds.currentRound && ds.currentRound.type;
    if (type === 'abierta') {
        const a = ds.abierta;
        if (!a) return false;
        if (a.step === 'open') { closeAbierta(state); return false; }
        if (a.step !== 'correcting') return false; // aún sin abrir: no hay nada que cerrar
        scoreAbierta(state);
        a.step = 'revealed';
        a.revealStep = 0; // se destapan una a una (los puntos, al destapar la última)
        const qa = ds.questions[ds.currentQuestionIdx];
        if (qa && ds.abiertaWip) delete ds.abiertaWip[qa.id];
    }
    if (type === 'multirespuesta') autoScoreMultirespuesta(state);
    else if (type === 'precio') autoScorePrecio(state);
    else if (type === 'identidad') {
        // Las ordenaciones provisionales pasan a definitivas
        for (const ans of Object.values(ds.answers)) {
            if (!ans.submitted) { ans.submitted = true; ans.timerRemaining = preciseRemaining(state); }
        }
        autoScoreIdentidad(state);
    } else if (type === 'boom') {
        autoScoreBoom(state);
        ds.boomStep = 0; // el coordinador revela el orden posición a posición («Ir revelando»)
    }
    ds.phase = 'answer_revealed';
    state.pulsadorActivo = false;
    if (ds.aclara) { ds.aclara.level = 1; ds.aclara.running = false; }
    if (ds.pictionary) picArchive(state);
    computeLastQuestionScores(state);
    if (['multirespuesta', 'precio', 'boom', 'identidad', 'abierta'].includes(type)) {
        const lqs = Object.values(ds.lastQuestionScores || {});
        logAction(state, { action: 'scored', hits: lqs.filter(r => r.correct).length, answered: lqs.filter(r => !r.noAnswer).length, total: lqs.length });
    }
    const q = ds.questions[ds.currentQuestionIdx];
    if (q) {
        if (!ds.questionResults) ds.questionResults = {};
        ds.questionResults[q.id] = { answers: ds.answers, lastQuestionScores: ds.lastQuestionScores, identidad: ds.identidad, abierta: ds.abierta || undefined,
            pictionary: ds.pictionary ? { mode: ds.pictionary.mode, drawer: ds.pictionary.drawer, drawerPts: ds.pictionary.drawerPts || 0 } : undefined,
            buzzerWinner: ds.buzzerWinner || null, buzzerPoints: ds.buzzerPoints || 0, buzzerFailed: (ds.buzzerFailed || []).slice() };
    }
    return true;
}

// Al volver a una pregunta ya puntuada (Anterior, relanzarla…) se muestra revelada con su
// resultado: no se puede volver a responder ni sumar puntos otra vez.
function restoreQuestionResult(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    const r = q && ds.questionResults && ds.questionResults[q.id];
    if (!r) return false;
    ds.answers = r.answers || {};
    ds.lastQuestionScores = r.lastQuestionScores || {};
    if (r.identidad) ds.identidad = r.identidad;
    if (r.abierta) { ds.abierta = r.abierta; ds.abierta.step = 'revealed'; ds.abierta.revealStep = abiertaSubs(ds).length; }
    ds.buzzerWinner = r.buzzerWinner || null;
    ds.buzzerPoints = r.buzzerPoints || 0;
    ds.buzzerFailed = r.buzzerFailed || [];
    if (ds.currentRound && ds.currentRound.type === 'aclara') ds.aclara = { level: 1, running: false, since: 0, rate: 1 / 30 };
    // Pictionary ya jugado: quién dibujó y el dibujo tal cual quedó (si el servidor aún lo recuerda)
    if (ds.currentRound && ds.currentRound.type === 'pictionary') {
        const rp = r.pictionary || {};
        ds.pictionary = { step: 'drawing', mode: rp.mode || picCfg(ds).mode, drawer: rp.drawer || null, drawerPts: rp.drawerPts || 0, pausedByBuzz: false };
        const b = picBoard(state);
        const saved = state._picDrawings && state._picDrawings.get(q.id);
        if (b) { b.strokes = saved || []; b.seq = 1; b.size = b.strokes.reduce((n, s) => n + s.p.length, 0); }
    }
    // Boom ya puntuado: se vuelve a ver con el orden completo
    ds.boomStep = (ds.currentRound && ds.currentRound.type === 'boom' && q.content && Array.isArray(q.content.items)) ? q.content.items.length : null;
    ds.optionsRevealed = true;
    ds.timer.running = false;
    ds.phase = 'answer_revealed';
    state.pulsadorActivo = false;
    return true;
}

// Arranca el temporizador de la pregunta. Siempre limpia el intervalo anterior: nunca puede
// haber dos a la vez (un intervalo huérfano seguiría restando y puntuando por su cuenta).
function startQuestionTimer(state, gameId, io) {
    const ds = state.director;
    if (state._timerHandle) { clearInterval(state._timerHandle); state._timerHandle = null; }
    ds.timer.running = true;
    state._tickAt = Date.now();
    logTick(state);
    const handle = setInterval(() => {
        if (state._timerHandle !== handle) { clearInterval(handle); return; }
        ds.timer.remaining = Math.max(0, ds.timer.remaining - 1);
        state._tickAt = Date.now();
        logTick(state);
        io.to(roomOf(gameId)).emit('game:timer_tick', { remaining: ds.timer.remaining, total: ds.timer.total });
        if (ds.timer.remaining <= 0) {
            stopTimer(state, gameId, io);
            // Al agotarse el tiempo se puntúa y se revela automáticamente
            finalizeQuestion(state);
            broadcastDirector(io, gameId, state);
        }
    }, 1000);
    state._timerHandle = handle;
}

// ───────────── Respuestas reenviadas tras un corte ─────────────
// Si una respuesta se perdió (o se pulsó sin conexión), el iPad la reenvía al volver indicando
// hace cuánto se pulsó ("ago", ms). Se cuenta con el tiempo que quedaba en ese momento, no con el
// de llegada, para no penalizar al equipo por el corte. Para que no se pueda abusar: como mucho
// MAX_AGO_MS hacia atrás y nunca antes de que se mostraran las opciones.
const MAX_AGO_MS = 10000;
function logTick(state) {
    const ds = state.director;
    const epoch = ds.questionEpoch || 0;
    if (!state._ticks || state._ticks.epoch !== epoch) state._ticks = { epoch, list: [] };
    state._ticks.list.push({ t: Date.now(), r: ds.timer.remaining });
    if (state._ticks.list.length > 40) state._ticks.list.shift();
}
// Tiempo que quedaba en un instante, con milésimas: el reloj visible baja de segundo en segundo,
// pero el bonus por rapidez no puede dar lo mismo a dos equipos que responden en el mismo segundo.
function preciseRemaining(state, at) {
    const ds = state.director;
    const r = ds.timer.remaining;
    if (!ds.timer.running || !state._tickAt) return r;
    const frac = Math.min(1, Math.max(0, ((at || Date.now()) - state._tickAt) / 1000));
    return Math.max(0, r - frac);
}
// Bonus por rapidez: proporcional al tiempo que quedaba (con milésimas) al responder
function timeBonus(cfg, ds, remaining) {
    if (!(ds.timer.total > 0) || !(cfg.bonusMax > 0)) return 0;
    return Math.floor(cfg.bonusMax * Math.min(1, Math.max(0, (Number(remaining) || 0) / ds.timer.total)));
}
function answerTiming(state, data) {
    const ds = state.director;
    const t = Date.now();
    const now = preciseRemaining(state, t);
    const ago = Math.min(MAX_AGO_MS, Math.max(0, Number(data && data.ago) || 0));
    if (!ago) return { timestamp: t, timerRemaining: now };
    const target = Math.max(t - ago, ds.optionsRevealedAt || t);
    const ticks = (state._ticks && state._ticks.epoch === (ds.questionEpoch || 0)) ? state._ticks.list : [];
    let remaining = now;
    if (ticks.length) {
        let found = null;
        for (let k = ticks.length - 1; k >= 0; k--) if (ticks[k].t <= target) { found = ticks[k]; break; }
        remaining = found ? Math.max(found.r - 1, found.r - (target - found.t) / 1000)
                          : ticks[0].r + (ticks[0].t - target) / 1000;
    }
    return { timestamp: target, timerRemaining: Math.max(now, Math.min(ds.timer.total, remaining)) };
}

function computeKaraokeAutoCombo(karaokeState, configColors) {
    const { history, colorParticipation } = karaokeState;
    const n = configColors.length;

    // Generate all valid combos (solos + pairs + all-together; never trios)
    const combos = [];
    for (let i = 0; i < n; i++) combos.push([configColors[i]]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) combos.push([configColors[i], configColors[j]]);
    if (n > 1) combos.push([...configColors]);
    // Deduplicate all-together if it matches a pair (n === 2)
    const comboKeys = new Set();
    const uniqueCombos = [];
    for (const c of combos) {
        const k = c.slice().sort().join(',');
        if (!comboKeys.has(k)) { comboKeys.add(k); uniqueCombos.push(c); }
    }

    // Add silence
    const allCandidates = [...uniqueCombos, []];

    // Remove last combo from candidates (no consecutive repeat)
    const lastCombo = history.length > 0 ? history[history.length - 1] : null;
    function comboEqual(a, b) {
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        const sa = a.slice().sort(); const sb = b.slice().sort();
        return sa.every((v, i) => v === sb[i]);
    }
    let candidates = allCandidates.filter(c => !comboEqual(c, lastCombo));
    if (candidates.length === 0) candidates = allCandidates;

    // Silence with ~10% probability (never on first block, never consecutive)
    const lastWasSilence = lastCombo && lastCombo.length === 0;
    if (history.length > 0 && !lastWasSilence && Math.random() < 0.10) return [];
    // Remove silence from candidates for weighted selection
    candidates = candidates.filter(c => c.length > 0);

    if (candidates.length === 0) return configColors.length > 0 ? [configColors[0]] : [];

    // Weighted selection favoring less-participated colors
    const maxPart = Math.max(...Object.values(colorParticipation), 0);
    const weights = candidates.map(combo => {
        return combo.reduce((sum, color) => sum + (maxPart - (colorParticipation[color] || 0) + 1), 0);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
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
        const bonus = timeBonus(cfg, ds, valid[0].timerRemaining);
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
        const ok = picked.length >= 1 && picked.every(a => correctSet.has(a)); // vale cualquiera de las correctas
        if (!ds.scores[teamId]) ds.scores[teamId] = 0;
        if (ok) {
            const bonus = timeBonus(cfg, ds, ans.timerRemaining);
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

// Ruleta: las letras sin destapar se sustituyen (se conserva la forma: espacios y signos)
function maskPhrase(phrase, revealed) {
    const PUNCT = ',.!?¡¿:;—–-\'"()';
    const rev = new Set(revealed.map(l => String(l).toUpperCase()));
    return Array.from(phrase).map(ch => (ch === ' ' || PUNCT.includes(ch) || rev.has(ch.toUpperCase())) ? ch : '•').join('');
}

// Boom: orden barajado (estable durante la pregunta) en que se muestran los elementos
function boomPerm(ds, n) {
    const key = (ds.currentRoundId || '') + ':' + ds.currentQuestionIdx + ':' + (ds.questionEpoch || 0);
    if (!ds._boomPerm || ds._boomPerm.key !== key || ds._boomPerm.perm.length !== n) {
        ds._boomPerm = { key, perm: shuffleNotIdentical(Array.from({ length: n }, (_, i) => i)) };
    }
    return ds._boomPerm.perm;
}

// Traduce el orden que manda un iPad (índices de lo que ve) a índices reales del contenido.
// Devuelve null si no es una lista válida. En Identidad un hueco puede ir vacío (null): el
// equipo no colocó esa pareja y no puntúa. Ningún elemento puede repetirse.
function toCanonicalOrder(ds, order) {
    const type = ds.currentRound && ds.currentRound.type;
    const q = ds.questions[ds.currentQuestionIdx];
    if (!q || !Array.isArray(order)) return null;
    let map = null;
    if (type === 'boom' && Array.isArray(q.content && q.content.items)) map = boomPerm(ds, q.content.items.length);
    if (type === 'identidad' && ds.identidad && Array.isArray(ds.identidad.shuffledRight)) map = ds.identidad.shuffledRight;
    if (!map) return order;
    const allowEmpty = type === 'identidad';
    if (order.length > map.length) return null;
    if (!order.every(k => (allowEmpty && k === null) || (Number.isInteger(k) && k >= 0 && k < map.length))) return null;
    const used = order.filter(k => k !== null);
    if (new Set(used).size !== used.length) return null;
    return order.map(k => (k === null ? null : map[k]));
}

function shuffleNotIdentical(arr) {
    if (arr.length < 2) return arr.slice();
    let shuffled;
    do {
        shuffled = shuffleArray(arr);
    } while (JSON.stringify(shuffled) === JSON.stringify(arr));
    return shuffled;
}

// Boom e Identidad se revelan paso a paso: sus puntos esperan en ds.pendingScores y se suman al
// destapar la última posición/pareja (más emoción). Si el coordinador sale de la pregunta antes,
// se suman al salir: nunca se pierden.
function addPending(ds, teamId, pts) {
    if (!ds.pendingScores) ds.pendingScores = {};
    ds.pendingScores[teamId] = (ds.pendingScores[teamId] || 0) + pts;
}
function applyPendingScores(state) {
    const ds = state.director;
    const p = ds.pendingScores;
    if (!p) return false;
    for (const [teamId, pts] of Object.entries(p)) {
        if (!ds.scores[teamId]) ds.scores[teamId] = 0;
        ds.scores[teamId] += pts;
    }
    ds.pendingScores = null;
    return true;
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
            const bonus = timeBonus(cfg, ds, ans.timerRemaining);
            addPending(ds, teamId, proportional + bonus);
        } else {
            addPending(ds, teamId, proportional);
            if (cfg.penalty > 0 && correctCount < nPairs) {
                addPending(ds, teamId, -cfg.penalty);
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
            const bonus = timeBonus(cfg, ds, ans.timerRemaining);
            addPending(ds, teamId, cfg.basePoints + bonus);
        } else if (cfg.penalty > 0) {
            addPending(ds, teamId, -cfg.penalty);
        }
    }
}

const BUZZER_RESULT_TYPES = new Set(['pulsador', 'ruleta', 'imagen', 'imagen_fija', 'cancion', 'aclara', 'pictionary']);
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
            entry.correct = picked.length >= 1 && picked.every(a => correctSet.has(a));
            if (entry.correct) {
                const bonus = timeBonus(cfg, ds, ans.timerRemaining);
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
            // Misma cifra que el ganador (p. ej. dos equipos clavan el precio): acertó igual, pero
            // el ganador respondió antes. El iPad lo explica en vez de decir «te quedaste corto».
            if (!entry.correct && precioWinnerId && ds.answers[precioWinnerId] && Number(ds.answers[precioWinnerId].answer) === val) {
                const w = state.equipos.find(e => e.id === precioWinnerId);
                entry.sameAsWinner = true;
                entry.exact = val === cv;
                entry.winnerName = w ? w.nombre : '';
            }
            if (entry.correct) {
                const bonus = timeBonus(cfg, ds, ans.timerRemaining);
                entry.points = cfg.basePoints + bonus;
            }
        } else if (roundType === 'boom' && c.correct_order) {
            const order = c.correct_order;
            const submitted = Array.isArray(ans.answer) ? ans.answer : [];
            entry.correct = JSON.stringify(submitted) === JSON.stringify(order);
            if (entry.correct) {
                const bonus = timeBonus(cfg, ds, ans.timerRemaining);
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
                const bonus = timeBonus(cfg, ds, ans.timerRemaining);
                entry.points = proportional + bonus;
            } else {
                entry.points = proportional;
                if (cfg.penalty > 0 && correctCount < nPairs) {
                    entry.points -= cfg.penalty;
                }
            }
        } else if (roundType === 'abierta' && ds.abierta) {
            if (!ans.submitted) continue;
            const n = Array.isArray(c.subs) ? c.subs.length : 0;
            const marks = (((ds.abierta.marks || {})[teamId]) || []).slice(0, n).map(Boolean);
            while (marks.length < n) marks.push(false);
            entry.marks = marks;
            entry.correctCount = marks.filter(Boolean).length;
            entry.totalSubs = n;
            entry.correct = n > 0 && entry.correctCount === n;
            entry.points = ((ds.abierta.points || {})[teamId]) || 0;
            entry.winner = ds.abierta.winner === teamId;
            entry.late = !!ans.late; // no llegó a enviar: contó lo escrito al cerrar
        }
        results[teamId] = entry;
    }

    // Pruebas de pulsador: no hay respuestas escritas, así que el resumen dice quién acertó al
    // pulsar (con los puntos que se llevó) y quién falló
    if (BUZZER_RESULT_TYPES.has(roundType)) {
        for (const tid of (ds.buzzerFailed || [])) {
            if (!results[tid]) results[tid] = { answer: 'Falló al pulsar', correct: false, points: cfg.penalty > 0 ? -cfg.penalty : 0, buzzer: true };
        }
        if (ds.buzzerWinner && !results[ds.buzzerWinner]) {
            results[ds.buzzerWinner] = { answer: 'Acertó al pulsar', correct: true, points: ds.buzzerPoints || 0, buzzer: true };
        }
        // Pictionary: el equipo que dibujaba (se lleva sus puntos si alguien lo adivinó)
        const pd = ds.pictionary && ds.pictionary.mode === 'equipos' && ds.pictionary.drawer;
        if (pd && !results[pd]) {
            results[pd] = { answer: 'Dibujó', correct: !!ds.buzzerWinner, points: ds.pictionary.drawerPts || 0, buzzer: true, drawer: true };
        }
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

// Vista para iPads y pantalla. forPlayers=true quita lo que delataría la solución en el
// dispositivo de un equipo: frase de la ruleta (solo letras ya destapadas), imagen completa de
// "Adivina la imagen" y orden de Boom/Identidad (los elementos viajan barajados y el servidor
// traduce la respuesta). La pantalla recibe la vista completa para poder dibujar y animar.
function playerView(state, forPlayers) {
    const ds = state.director;
    const curQ = ds.questions[ds.currentQuestionIdx];
    let question = null;
    if (curQ && (ds.phase === 'question' || ds.phase === 'answer_revealed')) {
        const c = { ...curQ.content };
        const type = ds.currentRound && ds.currentRound.type;
        if (ds.phase === 'question' && forPlayers) {
            if (type === 'ruleta' && !ds.rouletteSolved && typeof c.phrase === 'string') c.phrase = maskPhrase(c.phrase, ds.rouletteRevealed || []);
            if (type === 'imagen' || type === 'aclara') { delete c.image; delete c.answer; }
        }
        if (ds.phase === 'question' && type === 'boom' && Array.isArray(c.items)) {
            const perm = boomPerm(ds, c.items.length);
            c.items = perm.map(i => c.items[i]);
        }
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
                        // Las derechas viajan ya barajadas; el índice k que maneja el iPad
                        // corresponde a shuffledRight[k] (el servidor lo traduce al recibir)
                        const sh = (ds.identidad && ds.identidad.shuffledRight) || c.pairs.map((p, i) => i);
                        const rights = c.pairs.map(p => p.right);
                        c.rightsCanonical = sh.map(ci => rights[ci]);
                        c.pairs = c.pairs.map(p => ({ left: p.left }));
                        c.rightShuffled = sh.map((ci, k) => k);
                    }
                }
            }
            delete c.correct; delete c.answer; delete c.correct_value; delete c.correct_order;
            // Pictionary: la palabra solo la tienen el coordinador y quien dibuja (pic:word). Tampoco la
            // pantalla: sin pantalla, cada iPad lleva su vista incrustada.
            if (type === 'pictionary') delete c.word;
        }
        // Boom revelado por pasos: a los iPads solo les llega lo ya destapado del orden correcto
        if (ds.phase === 'answer_revealed' && forPlayers && type === 'boom' && typeof ds.boomStep === 'number' && Array.isArray(c.correct_order)) {
            c.correct_order = c.correct_order.slice(0, ds.boomStep);
        }
        // Respuesta abierta: las subpreguntas solo desde «Mostrar subpreguntas»; las respuestas
        // correctas, una a una según se revelan. Las otras válidas no salen nunca del servidor.
        if (type === 'abierta') {
            const a = ds.abierta || {};
            const subs = Array.isArray(c.subs) ? c.subs : [];
            const revealed = ds.phase === 'answer_revealed';
            const showSubs = revealed || (a.step && a.step !== 'intro');
            const rs = revealed ? (a.revealStep || 0) : 0;
            c.nSubs = subs.length;
            c.subs = showSubs ? subs.map((s, i) => (i < rs ? { text: s.text, answer: s.answer } : { text: s.text })) : [];
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
        equipos: state.equipos.map(e => ({ id: e.id, nombre: e.nombre, photo_url: e.photo_url, ocupado: e.ocupado, bloqueado: e.bloqueado, bonos: e.bonos })),
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
        lastQuestionScores: abiertaScoresView(ds, forPlayers),
        questionKey: (ds.currentRoundId || '') + ':' + ds.currentQuestionIdx + ':' + (ds.questionEpoch || 0), // cambia también al relanzar la misma pregunta
        buzzerFailed: ds.buzzerFailed || [],
        buzzerWinner: ds.buzzerWinner || null, // equipo que acertó en el pulsador (para mostrar el resultado)
        buzzerPoints: ds.buzzerPoints || 0,
        showTeamResults: ds.showTeamResults,
        scoreboardVisible: ds.scoreboardVisible,
        qrVisible: ds.qrVisible,
        qrPass: ds.qrVisible ? ds.qrPass : null,
        premioAnuncioVisible: ds.premioAnuncioVisible,
        premioGanadorVisible: ds.premioGanadorVisible,
        premioGanadorTeam: ds.premioGanadorTeam,
        premioGanadorTipo: ds.premioGanadorTipo,
        premioGanadorExtra: ds.premioGanadorExtra || null,
        premioTipo: (curQ && curQ.config && curQ.config.premio) ? curQ.config.premio.tipo : null,
        premioAnuncioCantidad: (curQ && curQ.config && curQ.config.premio && curQ.config.premio.tipo === 'puntos') ? (Number(curQ.config.premio.cantidad) || 0) : null,
        preCountdown: ds.preCountdown || 0,
        gameTheme: state._gameTheme || {},
        typeTheme: resolveTypeTheme(state, ds.currentRound ? ds.currentRound.type : null),
        roundTheme: { logo: roundCfg.logo || null, background: roundCfg.background || null },
        rounds: roundsSummary,
        precioWinner,
        videoState: ds.videoState || null,
        identidad: ds.identidad ? { revealIndex: ds.identidad.revealIndex } : null,
        boomStep: typeof ds.boomStep === 'number' ? ds.boomStep : null, // posiciones de Boom ya reveladas
        abierta: ds.abierta ? { step: ds.abierta.step, revealStep: ds.abierta.revealStep || 0 } : null, // paso de Respuesta abierta
        aclara: aclaraView(ds), // nitidez actual de «Imagen que se aclara» (el cliente la anima desde aquí)
        // Pictionary: quién dibuja y en qué paso va (la palabra no: va solo a quien dibuja)
        pictionary: ds.pictionary ? { step: ds.pictionary.step, mode: ds.pictionary.mode, drawer: ds.pictionary.drawer || null,
            drawerName: picDrawerName(state), drawerPts: ds.pictionary.drawerPts || 0, paused: !!ds.pictionary.pausedByBuzz } : null,
        padConnected: !!ds.padConnected, // pizarra fija enlazada
        noScreen: !!ds.noScreen,          // modo sin pantalla: los iPads llevan el escenario
        audioOn: ds.audioOn || 'sala',    // dónde suena (vídeo y efectos): 'sala' (ordenador) o 'ipads'
        karaoke: ds.karaoke ? { blocks: ds.karaoke.blocks, blockIdx: ds.karaoke.blockIdx, activeCombo: ds.karaoke.activeCombo, finished: ds.karaoke.finished, winnerColor: ds.karaoke.winnerColor, teamsByColor: ds.karaoke.teamsByColor } : null,
    };
}

// Respuesta abierta revelándose: a los iPads solo les llega lo destapado (verde/rojo de las
// subpreguntas ya reveladas; los puntos y el ganador, al terminar)
function abiertaScoresView(ds, forPlayers) {
    const lqs = ds.lastQuestionScores;
    if (!forPlayers || !ds.abierta || ds.phase !== 'answer_revealed' || !lqs) return lqs;
    const rs = ds.abierta.revealStep || 0;
    const out = {};
    for (const [tid, r] of Object.entries(lqs)) {
        if (!r || !Array.isArray(r.marks) || rs >= r.marks.length) { out[tid] = r; continue; }
        out[tid] = { answer: r.answer, marks: r.marks.slice(0, rs), totalSubs: r.totalSubs, late: r.late, pending: true };
    }
    return out;
}

function emitYourOrder(socket, state) {
    if (!socket.equipoId) return;
    const ds = state.director;
    // Pictionary: si este equipo está dibujando, vuelve a recibir la palabra
    if (ds.pictionary) {
        if (ds.pictionary.mode === 'equipos' && ds.pictionary.drawer === socket.equipoId) sendPicWord(socket, state);
        return;
    }
    // Respuesta abierta: al volver (corte, otro iPad) el equipo recupera lo que tenía escrito
    if (ds.currentRound && ds.currentRound.type === 'abierta') {
        const e = ds.answers[socket.equipoId];
        if (e && ds.phase === 'question') socket.emit('game:your_abierta', { texts: Array.isArray(e.answer) ? e.answer : [], submitted: !!e.submitted });
        return;
    }
    if (!(ds.currentRound && ds.currentRound.type === 'identidad')) return;
    const entry = ds.answers[socket.equipoId];
    if (!entry) return;
    let order = entry.answer;
    const sh = ds.identidad && ds.identidad.shuffledRight;
    if (ds.phase === 'question' && Array.isArray(sh) && Array.isArray(order)) order = order.map(ci => (ci === null ? null : sh.indexOf(ci)));
    socket.emit('game:your_order', { order, submitted: !!entry.submitted });
}

function aplicarDescongelacionPorPregunta(state, io, gameId) {
    const freezeMode = state._gameTheme && state._gameTheme.freezeMode || 'coordinador';
    if (freezeMode !== 'pregunta') return;
    let cambios = false;
    state.equipos.forEach(eq => {
        if (eq.bloqueado && eq.descongelaEn > 0) {
            eq.descongelaEn -= 1;
            if (eq.descongelaEn <= 0) {
                eq.bloqueado = false;
                eq.descongelaEn = 0;
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
                cambios = true;
            }
        }
    });
    if (cambios) io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
}

function avanzarPregunta(state, io, gameId) {
    applyPendingScores(state);
    const ds = state.director;
    if (ds.currentQuestionIdx >= ds.questions.length - 1) return false;
    aplicarDescongelacionPorPregunta(state, io, gameId);
    stopTimer(state, gameId, io);
    ds.currentQuestionIdx++;
    ds.phase = 'question';
    ds.answers = {};
    ds.revealedCells = [];
    ds.revealedLetters = [];
    ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
    ds.optionsRevealed = false; ds.optionsRevealedAt = null;
    ds.lastQuestionScores = {};
    ds.showTeamResults = false;
    initIdentidadState(ds); initAclaraState(ds); initAbiertaState(ds); initPictionaryState(state);
    if (isNoTimerRound(ds)) {
        ds.timer = { total: 0, remaining: 0, running: false };
    } else {
        const cfg = getQuestionConfig(state);
        ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
    }
    state.pulsadorActivo = false;
    state.colaPulsador = [];
    // Pregunta ya puntuada: se muestra con su resultado, sin volver a responder ni puntuar
    restoreQuestionResult(state);
    ds.premioGanadorVisible = false;
    ds.premioGanadorExtra = null;
    setPremioAnuncio(state);
    broadcastDirector(io, gameId, state);
    return true;
}

function finalizarRonda(state, io, gameId) {
    const ds = state.director;
    if (ds.currentRoundId && ds.completedRounds.indexOf(ds.currentRoundId) === -1) {
        ds.completedRounds.push(ds.currentRoundId);
    }
    stopTimer(state, gameId, io);
    ds.identidad = null;
    ds.optionsRevealed = false; ds.optionsRevealedAt = null;
    ds.lastQuestionScores = {};
    ds.showTeamResults = false;
    ds.scoreboardVisible = false;
    ds.qrVisible = false;
    ds.premioGanadorVisible = false;
    ds.premioGanadorExtra = null;
    ds.karaoke = null;
    ds.phase = 'round_end';
    broadcastDirector(io, gameId, state);
}

function setPremioAnuncio(state) {
    const ds = state.director;
    const q = ds.questions[ds.currentQuestionIdx];
    ds.premioAnuncioVisible = !!(q && q.config && q.config.premio);
}

function resolverPremioAsignado(state, data, io, gameId) {
    const ds = state.director;
    const qActual = ds.questions[ds.currentQuestionIdx];
    const premioCfg = (qActual && qActual.config && qActual.config.premio) || null;
    const teamId = data && data.teamId;
    ds.premioGanadorExtra = null;

    if (teamId) {
        const eq = state.equipos.find(e => e.id === teamId);
        if (eq) {
            const tipo = premioCfg ? premioCfg.tipo : (data && data.premioTipo);
            if (tipo === 'freeze' || tipo === 'lock_all') {
                eq.bonos.push(tipo);
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            } else if (tipo === 'puntos') {
                const cant = Number(premioCfg && premioCfg.cantidad) || 0;
                if (cant > 0) { if (!ds.scores[eq.id]) ds.scores[eq.id] = 0; ds.scores[eq.id] += cant; }
                ds.premioGanadorExtra = { cantidad: cant };
            } else if (tipo === 'anuncio') {
                ds.premioGanadorExtra = {
                    texto: (premioCfg && premioCfg.texto) || null,
                    imagenUrl: (premioCfg && premioCfg.imagenUrl) || null
                };
            }
            ds.premioGanadorTeam = eq.nombre;
            ds.premioGanadorTipo = tipo || null;
            const logEntry = { action: 'awarded', team: eq.nombre, bono: tipo, ts: Date.now() };
            if (tipo === 'puntos') logEntry.cantidad = Number(premioCfg && premioCfg.cantidad) || 0;
            if (tipo === 'anuncio') logEntry.texto = (premioCfg && premioCfg.texto) || null;
            logAction(state, logEntry);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
        }
    } else {
        ds.premioGanadorTeam = null;
        ds.premioGanadorTipo = null;
        ds.premioGanadorExtra = null;
        const premioTipo = data && data.premioTipo;
        if (premioTipo) logAction(state, { action: 'awarded', team: null, bono: premioTipo });
    }
    return { extra: ds.premioGanadorExtra, team: ds.premioGanadorTeam, tipo: ds.premioGanadorTipo };
}

// Envío del estado a coordinador, pantallas e iPads, agrupado: si llegan muchas acciones a la
// vez (50 equipos pulsando o respondiendo), en lugar de reenviar el estado completo a todos por
// cada una, se envía como mucho una vez cada 50 ms (siempre con el estado más reciente).
const BROADCAST_MS = 50;
const _broadcasts = new Map(); // gameId → { last, timer }
function broadcastDirector(io, gameId, state) {
    let b = _broadcasts.get(gameId);
    if (!b) { b = { last: 0, timer: null }; _broadcasts.set(gameId, b); }
    if (b.timer) return; // ya hay un envío programado: llevará este cambio
    const wait = BROADCAST_MS - (Date.now() - b.last);
    if (wait <= 0) { b.last = Date.now(); broadcastNow(io, gameId, state); return; }
    b.timer = setTimeout(() => { b.timer = null; b.last = Date.now(); broadcastNow(io, gameId, state); }, wait);
}

function broadcastNow(io, gameId, state) {
    io.to(`directors:${gameId}`).emit('game:director_sync', publicView(state));
    io.to(roomOf(gameId)).except(`screens:${gameId}`).emit('game:player_sync', playerView(state, true));
    io.to(`screens:${gameId}`).emit('game:player_sync', playerView(state, false));
}

function emitPlayerSync(socket, state) {
    socket.emit('game:player_sync', playerView(state, !socket.isScreen));
}

function resolveGameId(requestedId) {
    if (!requestedId) return DEFAULT_GAME_ID;
    const row = db.prepare('SELECT id FROM games WHERE id = ?').get(requestedId);
    return row ? row.id : DEFAULT_GAME_ID;
}

// Foto de equipo: solo una imagen subida a la propia app (nada de URLs externas ni código)
function safePhotoUrl(u) {
    return typeof u === 'string' && /^\/uploads\/images\/[A-Za-z0-9._-]+$/.test(u) ? u : null;
}

// Órdenes del coordinador que llevan { at, round } (pregunta en la que estaba al pulsar)
const POSITIONAL_EVENTS = new Set([
    'director:next_question', 'director:next_with_premio', 'director:prev_question', 'director:finish_round',
    'director:mark_correct', 'director:mark_wrong', 'director:karaoke_award',
    'director:abierta_show', 'director:abierta_open', 'director:abierta_close', 'director:abierta_reveal', 'director:abierta_mark',
    'director:pic_set_drawer', 'director:pic_start',
]);

// La conexión nueva de un iPad se queda con su equipo: la anterior (si sigue abierta) se
// desvincula y se cierra, para que no puedan pulsar dos conexiones del mismo equipo.
function takeOverTeam(eq, socket) {
    if (!eq.socketId || eq.socketId === socket.id || !_io) return;
    const prev = _io.sockets.sockets.get(eq.socketId);
    if (prev) {
        prev.equipoId = null;
        prev.disconnect(true);
    }
}

function attachSocketHandlers(io) {
    _io = io;
    io.on('connection', (socket) => {
        const requested = socket.handshake.query && socket.handshake.query.gameId;
        const gameId = resolveGameId(requested);
        const deviceId = socket.handshake.query && socket.handshake.query.deviceId;
        socket.gameId = gameId;

        // Roles: staff = sesión de backoffice/coordinador (cookie); hasPass = el iPad tiene pase del juego.
        socket.isStaff = !!auth.sessionFromCookieHeader(socket.handshake.headers.cookie);
        const pass = socket.handshake.query && socket.handshake.query.pass;
        socket.hasPass = auth.verifyGamePass(gameId, pass);
        // Solo reciben lo que pasa en el juego quienes tienen pase o sesión (la pantalla entra con screen:join).
        // Una conexión anónima sin código ya no escucha la sala.
        if (socket.hasPass || socket.isStaff) socket.join(roomOf(gameId));

        // Un dato mal formado no debe tumbar el servidor (el marcador vive en este proceso):
        // cada handler se ejecuta protegido y el error solo se registra.
        const _on = socket.on.bind(socket);
        socket.on = (event, handler) => _on(event, (...args) => {
            try { return handler(...args); }
            catch (err) { console.error(`[socket ${event}]`, err && err.stack || err); }
        });

        // Las órdenes de coordinador solo se aceptan de conexiones con sesión.
        socket.use(([event, data], next) => {
            if (event.startsWith('director:') || event.startsWith('admin_')) {
                // Se vuelve a comprobar la cookie del handshake (época y caducidad): si se cambió
                // la contraseña o caducó, el coordinador abre la conexión de nuevo con la cookie actual
                if (socket.isStaff && !auth.sessionFromCookieHeader(socket.handshake.headers.cookie)) socket.isStaff = false;
                if (!socket.isStaff) { socket.emit('auth_required'); return; }
            }
            // Orden ligada a una pregunta que ya no es la actual (doble toque, reenvío): se ignora
            if (POSITIONAL_EVENTS.has(event) && data && data.at !== undefined) {
                const ds = getOrCreateState(gameId).director;
                if (data.at !== ds.currentQuestionIdx || (data.round || null) !== (ds.currentRoundId || null)) return;
            }
            next();
        });

        const state = getOrCreateState(gameId);

        // El estado completo (incluye respuestas) solo viaja a coordinadores vía game:director_sync.
        socket.emit('init_connection', { gameId });

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
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
        }

        // ═══════════════════════ PLAYER TEAM REGISTRATION ═══════════════════════

        socket.on('player:register_team', (data) => {
            if (!socket.hasPass) { socket.emit('register_error', { error: 'Código de acceso no válido', reason: 'no_pass' }); return; }
            if (!data || !data.name || !data.name.trim()) return;
            const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(gameId);
            if (!session) { socket.emit('register_error', { error: 'No hay sesión activa' }); return; }

            const teamName = data.name.trim();
            const photoUrl = safePhotoUrl(data.photo_url);
            const devId = data.deviceId || deviceId || null;

            // Check if device already has a team
            if (devId) {
                const existingDb = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, devId);
                if (existingDb) {
                    // Reconnect to existing team
                    let eq = state.equipos.find(e => e.id === existingDb.id);
                    if (!eq) {
                        eq = team({ id: existingDb.id, nombre: existingDb.name, photo_url: existingDb.photo_url, ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: devId });
                        state.equipos.push(eq);
                        if (!state.director.scores[eq.id]) state.director.scores[eq.id] = 0;
                    }
                    takeOverTeam(eq, socket);
                    eq.ocupado = true;
                    eq.socketId = socket.id;
                    socket.equipoId = eq.id;
                    state._gameTheme = loadGameTheme(gameId);
                    socket.emit('login_success', { miEquipo: eq, equiposRivales: state.equipos });
                    emitPlayerSync(socket, state);
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

            const eq = team({ id: teamId, nombre: teamName, photo_url: photoUrl, ocupado: true, bonos: [], bloqueado: false, socketId: socket.id, deviceId: devId });
            state.equipos.push(eq);
            state.director.scores[teamId] = 0;
            state.juegoIniciado = true;
            socket.equipoId = teamId;

            state._gameTheme = loadGameTheme(gameId);
            socket.emit('login_success', { miEquipo: eq, equiposRivales: state.equipos });
            emitPlayerSync(socket, state);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        // ── Recuperar un equipo en otro iPad (código de un solo uso que da el coordinador) ──
        socket.on('player:recover_team', (data) => {
            const fail = (error) => socket.emit('recover_result', { ok: false, error });
            if (!socket.hasPass) { fail('Código de acceso del juego no válido'); return; }
            socket._recoverFails = socket._recoverFails || 0;
            if (socket._recoverFails >= 8) { fail('Demasiados intentos. Recarga la página y pide un código nuevo.'); return; }
            const code = String((data && data.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            const devId = (data && data.deviceId) || deviceId;
            const rec = state._recovery && state._recovery[code];
            if (!rec || rec.exp < Date.now()) { socket._recoverFails++; fail('Código no válido o caducado. Pide uno nuevo al coordinador.'); return; }
            if (!devId) { fail('Este iPad no tiene identificador: recarga la página'); return; }
            const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(gameId);
            if (!session) { fail('No hay ninguna partida en marcha'); return; }
            const eq = state.equipos.find(e => e.id === rec.teamId);
            if (!eq) { fail('Ese equipo ya no está en la partida'); return; }
            const own = db.prepare('SELECT id, name FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, devId);
            if (own && own.id !== eq.id) { fail('Este iPad ya es el equipo «' + own.name + '». Pide al coordinador que lo elimine y vuelve a intentarlo.'); return; }
            delete state._recovery[code];
            db.prepare('UPDATE teams SET device_id = ? WHERE id = ?').run(devId, eq.id);
            eq.deviceId = devId;
            takeOverTeam(eq, socket); // el iPad viejo, si sigue encendido, se desconecta
            eq.ocupado = true;
            eq.socketId = socket.id;
            socket.equipoId = eq.id;
            state._gameTheme = loadGameTheme(gameId);
            socket.emit('recover_result', { ok: true, name: eq.nombre });
            socket.emit('login_success', { miEquipo: eq, equiposRivales: state.equipos });
            emitPlayerSync(socket, state);
            emitYourOrder(socket, state);
            logAction(state, { action: 'recovered', team: eq.nombre });
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        // Device-based auto-reconnect
        socket.on('player:reconnect', (data) => {
            if (!socket.hasPass) { socket.emit('reconnect_failed', { reason: 'no_pass' }); return; }
            const devId = data && data.deviceId || deviceId;
            if (!devId) { socket.emit('reconnect_failed', { reason: 'no_device' }); return; }
            const session = db.prepare('SELECT id FROM sessions WHERE game_id = ? AND ended_at IS NULL LIMIT 1').get(gameId);
            if (!session) { socket.emit('reconnect_failed', { reason: 'no_session' }); return; }
            const dbTeam = db.prepare('SELECT * FROM teams WHERE session_id = ? AND device_id = ?').get(session.id, devId);
            if (!dbTeam) { socket.emit('reconnect_failed', { reason: 'no_team' }); return; }

            let eq = state.equipos.find(e => e.id === dbTeam.id);
            if (!eq) {
                eq = team({ id: dbTeam.id, nombre: dbTeam.name, photo_url: dbTeam.photo_url, ocupado: false, bonos: [], bloqueado: false, socketId: null, deviceId: devId });
                state.equipos.push(eq);
                if (!state.director.scores[eq.id]) state.director.scores[eq.id] = 0;
            }

            // Es el mismo iPad (mismo deviceId): al volver de un corte de WiFi o de bloquear la
            // pantalla, el servidor aún puede creer viva la conexión anterior (hasta ~45 s).
            // Se queda con el equipo la conexión nueva y se cierra la vieja.
            takeOverTeam(eq, socket);

            eq.ocupado = true;
            eq.socketId = socket.id;
            socket.equipoId = eq.id;

            state._gameTheme = loadGameTheme(gameId);
            socket.emit('login_success', { miEquipo: eq, equiposRivales: state.equipos });
            emitPlayerSync(socket, state);
            emitYourOrder(socket, state);
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ ADMIN (legacy) ═══════════════════════
        // Solo accesibles con sesión de staff (ver socket.use arriba). join_team y login_admin eliminados.

        socket.on('admin_crear_juego', (n) => {
            const total = Math.max(1, Math.min(20, Number(n) || 0));
            state.equipos = [];
            for (let i = 1; i <= total; i++) {
                state.equipos.push(team({ id: `eq${i}`, nombre: `Equipo ${i}`, photo_url: null, ocupado: false, bonos: [], bloqueado: false }));
            }
            state.juegoIniciado = true;
            state.colaPulsador = [];
            state.bloqueoGlobal = false;
            state.pulsadorActivo = false;
            io.to(roomOf(gameId)).emit('juego_iniciado_teams', state.equipos);
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
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
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
            if (state.vistaActual === 'espera') io.to(`directors:${gameId}`).emit('cambio_de_escena', publicView(state));
        });

        socket.on('admin_set_escena', (d) => {
            state.vistaActual = d.vista;
            if (d.vista === 'web' && d.url) state.urlActual = d.url;
            if (d.saveSlot !== undefined && d.urlToSave) state.urlsGuardadas[d.saveSlot] = d.urlToSave;
            io.to(`directors:${gameId}`).emit('cambio_de_escena', publicView(state));
        });

        socket.on('admin_gestionar_bono', (data) => {
            const eq = state.equipos.find(e => e.id === data.equipoId);
            if (!eq) return;
            if (data.accion === 'add') { eq.bonos.push(data.tipo); logAction(state, { action: 'bono_add', team: eq.nombre, bono: data.tipo }); }
            else if (data.accion === 'remove') {
                const idx = eq.bonos.indexOf(data.tipo);
                if (idx > -1) { eq.bonos.splice(idx, 1); logAction(state, { action: 'bono_remove', team: eq.nombre, bono: data.tipo }); }
            }
            broadcastDirector(io, gameId, state);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_toggle_bloqueo', (data) => {
            const eq = state.equipos.find(e => e.id === data.equipoId);
            if (!eq) return;
            eq.bloqueado = data.bloqueado;
            logAction(state, { action: data.bloqueado ? 'freeze' : 'unfreeze', team: eq.nombre });
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
        });

        socket.on('admin_toggle_global_lock', (valor) => {
            state.bloqueoGlobal = valor;
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
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
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
        });

        socket.on('admin_precio_nueva_partida', () => {
            if (state.precioTimeoutHandle) { clearTimeout(state.precioTimeoutHandle); state.precioTimeoutHandle = null; }
            state.precio.respuestas = {};
            state.precio.tiempoInicio = null;
            state.precio.fase = 'config';
            state.precio.ganadorId = null;
            state.precio.cifraCorrecta = null;
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
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
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
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
            io.to(`directors:${gameId}`).emit('sync_estado', publicView(state));
        });

        // ═══════════════════════ PLAYER ANSWERS ═══════════════════════

        socket.on('pulsar_boton', () => {
            const e = state.equipos.find(x => x.id === socket.equipoId);
            if (!e) return;
            if (!state.pulsadorActivo || state.bloqueoGlobal || e.bloqueado) return;
            if ((state.director.buzzerFailed || []).includes(e.id)) return; // ya falló esta pregunta
            if (state.colaPulsador.find(p => p.id === e.id)) return;
            const pic = state.director.pictionary;
            if (pic && pic.mode === 'equipos' && pic.drawer === e.id) return; // el equipo que dibuja no adivina
            var elapsed = state.buzzerOpenedAt ? Date.now() - state.buzzerOpenedAt : 0;
            // rem: tiempo que quedaba al pulsar (el bonus se cuenta desde aquí, no desde que el coordinador marca el acierto)
            const entry = { id: e.id, nombre: e.nombre, tiempo: Date.now(), elapsed: elapsed, rem: preciseRemaining(state) };
            if (state.director.aclara && state.director.phase === 'question') {
                aclaraPause(state.director); // la imagen se congela mientras alguien responde
                entry.level = state.director.aclara.level;
                entry.pts = aclaraPoints(getQuestionConfig(state).basePoints, entry.level);
            }
            state.colaPulsador.push(entry);
            // Pictionary: el tiempo se para mientras responden (vuelve a correr si fallan)
            if (pic && state.director.phase === 'question' && state.director.timer.running) {
                stopTimer(state, gameId, io);
                pic.pausedByBuzz = true;
            }
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_answer', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.currentRound && ds.currentRound.type === 'abierta') return; // tiene sus propios mensajes
            if (ds.answers[socket.equipoId]) return;
            ds.answers[socket.equipoId] = { answer: data.answer, ...answerTiming(state, data) };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_price', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (ds.answers[socket.equipoId]) return;
            const val = Number(data && data.value);
            if (!isFinite(val)) return;
            ds.answers[socket.equipoId] = { answer: val, ...answerTiming(state, data) };
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:submit_order', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (!data || !Array.isArray(data.order)) return;
            const order = toCanonicalOrder(ds, data.order);
            if (!order) return;
            const timing = answerTiming(state, data);
            data = { order };
            const existing = ds.answers[socket.equipoId];
            // For identidad: allow promoting provisional to definitive
            if (existing) {
                if (ds.currentRound && ds.currentRound.type === 'identidad' && !existing.submitted) {
                    existing.answer = data.order;
                    existing.timestamp = timing.timestamp;
                    existing.timerRemaining = timing.timerRemaining;
                    existing.submitted = true;
                } else {
                    return; // Already submitted (Boom or identidad definitive)
                }
            } else {
                ds.answers[socket.equipoId] = { answer: data.order, ...timing, submitted: true };
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('player:update_order', (data) => {
            if (!socket.equipoId) return;
            const ds = state.director;
            if (ds.phase !== 'question') return;
            if (!ds.optionsRevealed) return;
            if (!(ds.currentRound && ds.currentRound.type === 'identidad')) return;
            if (!data || !Array.isArray(data.order)) return;
            const order = toCanonicalOrder(ds, data.order);
            if (!order) return;
            const existing = ds.answers[socket.equipoId];
            if (existing && existing.submitted) return;
            ds.answers[socket.equipoId] = { answer: order, timestamp: Date.now(), timerRemaining: preciseRemaining(state), submitted: false };
        });

        // ── Respuesta abierta: borrador mientras escriben y envío definitivo ──
        // El borrador se guarda en el servidor (si se acaba el tiempo o se cierra, cuenta lo
        // escrito; si el iPad se corta, al volver lo recupera). No se reenvía a nadie.
        const abiertaTexts = (data) => {
            const ds = state.director;
            if (!socket.equipoId || ds.phase !== 'question' || !ds.abierta || ds.abierta.step !== 'open') return null;
            const eq = state.equipos.find(e => e.id === socket.equipoId);
            if (!eq || eq.bloqueado) return null;
            const prev = ds.answers[socket.equipoId];
            if (prev && prev.submitted) return null;
            const arr = data && data.texts;
            if (!Array.isArray(arr)) return null;
            const n = abiertaSubs(ds).length;
            return Array.from({ length: n }, (_, i) => String(arr[i] == null ? '' : arr[i]).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120));
        };
        socket.on('player:abierta_draft', (data) => {
            const texts = abiertaTexts(data);
            if (!texts) return;
            const ds = state.director;
            ds.answers[socket.equipoId] = { answer: texts, timestamp: Date.now(), timerRemaining: preciseRemaining(state), submitted: false };
        });
        socket.on('player:abierta_submit', (data) => {
            const texts = abiertaTexts(data);
            if (!texts || !texts.some(t => t.trim())) return;
            const ds = state.director;
            ds.answers[socket.equipoId] = { answer: texts, ...answerTiming(state, data), submitted: true };
            // Cuando han enviado todos los equipos (los congelados no cuentan) empieza la corrección
            const need = state.equipos.filter(e => !e.bloqueado);
            if (need.length && need.every(e => ds.answers[e.id] && ds.answers[e.id].submitted)) closeAbierta(state);
            broadcastDirector(io, gameId, state);
        });

        socket.on('usar_bono', (data) => {
            const emisor = state.equipos.find(e => e.id === socket.equipoId);
            if (!data || !emisor || !emisor.bonos.includes(data.tipo)) return;
            if (emisor.bloqueado) { socket.emit('notificacion_bono', { msg: 'Estáis congelados: no podéis usar bonos ahora' }); return; }
            let mensaje = '';
            let victima = null;
            if (data.tipo === 'lock_all') {
                state.equipos.forEach(eq => {
                    if (eq.id !== emisor.id) {
                        if (!eq.bloqueado) {
                            eq.bloqueado = true;
                            eq.descongelaEn = (state.director.phase === 'question') ? 1 : 2;
                            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
                        }
                    }
                });
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                mensaje = `${emisor.nombre} BLOQUEÓ AL RESTO DE EQUIPOS`;
            } else if (data.tipo === 'freeze') {
                victima = state.equipos.find(e => e.id === data.targetId);
                if (!victima) { socket.emit('notificacion_bono', { msg: 'Equipo no encontrado' }); return; }
                if (victima.id === emisor.id) { socket.emit('notificacion_bono', { msg: 'No te puedes congelar a ti mismo' }); return; }
                if (victima.bloqueado) { socket.emit('notificacion_bono', { msg: `${victima.nombre} ya está congelado` }); return; }
                victima.bloqueado = true;
                victima.descongelaEn = (state.director.phase === 'question') ? 1 : 2;
                mensaje = `${emisor.nombre} CONGELÓ A ${victima.nombre}`;
                io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
                if (victima.socketId) io.to(victima.socketId).emit('update_mi_equipo', victima);
            }
            const idx = emisor.bonos.indexOf(data.tipo);
            if (idx > -1) emisor.bonos.splice(idx, 1);
            logAction(state, {
                action: 'used', team: emisor.nombre, bono: data.tipo,
                target: data.tipo === 'freeze' ? (victima && victima.nombre) : null
            });
            socket.emit('update_mi_equipo', emisor);
            io.to(roomOf(gameId)).emit('notificacion_bono', { msg: mensaje });
            // Refrescar el panel del director en vivo tras registrar el bono en el log
            io.to(`directors:${gameId}`).emit('game:director_sync', publicView(state));
        });

        // ═══════════════════════ DIRECTOR ═══════════════════════

        socket.on('director:join', () => {
            socket.isDirector = true;
            socket.join(`directors:${gameId}`);
            socket.emit('game:director_sync', publicView(state));
        });

        socket.on('screen:join', (data) => {
            socket.isScreen = true;
            socket.isEmbed = !!(data && data.embed); // escenario dentro de un iPad (modo sin pantalla)
            socket.join(roomOf(gameId));
            socket.join(`screens:${gameId}`);
            state._gameTheme = loadGameTheme(gameId);
            emitPlayerSync(socket, state);
        });

        // ═══════════════════════ PRECARGA (estado por dispositivo para el coordinador) ═══════════════════════

        socket.on('player:preload_status', (data) => {
            const eq = state.equipos.find(e => e.id === socket.equipoId);
            if (!eq) return;
            eq.preload = cleanPreloadStatus(data);
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('screen:preload_status', (data) => {
            if (!state.director.screensPreload) state.director.screensPreload = {};
            state.director.screensPreload[socket.id] = cleanPreloadStatus(data);
            broadcastDirector(io, gameId, state);
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
                state.equipos.push(team({ id, nombre: `Equipo ${i}`, photo_url: null, ocupado: false, bonos: [], bloqueado: false }));
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
            if (data.photo_url !== undefined) { eq.photo_url = safePhotoUrl(data.photo_url); db.prepare('UPDATE teams SET photo_url = ? WHERE id = ?').run(eq.photo_url, eq.id); }
            if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:remove_team', (data) => {
            if (!data || !data.teamId) return;
            const idx = state.equipos.findIndex(e => e.id === data.teamId);
            if (idx < 0) return;
            const eq = state.equipos[idx];
            logAction(state, { action: 'team_removed', team: eq.nombre, pts: state.director.scores[data.teamId] || 0 });
            if (eq.socketId) {
                io.to(eq.socketId).emit('team_removed');
                const s = io.sockets.sockets.get(eq.socketId);
                if (s) s.equipoId = null; // sus respuestas y pulsaciones ya no cuentan
            }
            state.equipos.splice(idx, 1);
            delete state.director.scores[data.teamId];
            delete state.director.answers[data.teamId];
            state.colaPulsador = state.colaPulsador.filter(p => p.id !== data.teamId);
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            db.prepare('DELETE FROM teams WHERE id = ?').run(data.teamId);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:launch_round', (data) => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
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
            logAction(state, { action: 'round', name: round.name });
            ds.answers = {};
            ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:start_round', () => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            const ds = state.director;
            if (ds.currentRound && ds.questions.length > 0) {
                aplicarDescongelacionPorPregunta(state, io, gameId);
                ds.currentQuestionIdx = 0;
                ds.phase = 'question';
                ds.answers = {};
                ds.revealedCells = [];
                ds.revealedLetters = [];
                ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
                ds.optionsRevealed = false; ds.optionsRevealedAt = null;
                ds.lastQuestionScores = {};
                ds.showTeamResults = false;
                ds.scoreboardVisible = false;
                ds.qrVisible = false;
                ds.menuLevel = null;
                ds.selectedCategory = null;
                initIdentidadState(ds); initAclaraState(ds); initAbiertaState(ds); initPictionaryState(state);
                if (isNoTimerRound(ds)) {
                    ds.timer = { total: 0, remaining: 0, running: false };
                } else {
                    const cfg = getQuestionConfig(state);
                    ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                }
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                // Pregunta ya puntuada: se muestra con su resultado, sin volver a responder ni puntuar
                restoreQuestionResult(state);
                setPremioAnuncio(state);
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:launch_question', (data) => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            const ds = state.director;
            const idx = Number(data && data.idx);
            if (!isFinite(idx) || idx < 0 || idx >= ds.questions.length) return;
            aplicarDescongelacionPorPregunta(state, io, gameId);
            stopTimer(state, gameId, io);
            ds.currentQuestionIdx = idx;
            ds.phase = 'question';
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
            ds.optionsRevealed = false; ds.optionsRevealedAt = null;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            ds.premioGanadorVisible = false;
            initIdentidadState(ds); initAclaraState(ds); initAbiertaState(ds); initPictionaryState(state);
            if (isNoTimerRound(ds)) {
                ds.timer = { total: 0, remaining: 0, running: false };
            } else {
                const cfg = getQuestionConfig(state);
                ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
            }
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            // Pregunta ya puntuada: se muestra con su resultado, sin volver a responder ni puntuar
            restoreQuestionResult(state);
            setPremioAnuncio(state);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:next_question', () => {
            avanzarPregunta(state, io, gameId);
        });

        socket.on('director:next_with_premio', (data) => {
            const r = resolverPremioAsignado(state, data, io, gameId);
            avanzarPregunta(state, io, gameId);
            state.director.premioGanadorExtra = r.extra;
            state.director.premioGanadorTeam = r.team;
            state.director.premioGanadorTipo = r.tipo;
            state.director.premioGanadorVisible = true;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:prev_question', () => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            const ds = state.director;
            if (ds.currentQuestionIdx > 0) {
                stopTimer(state, gameId, io);
                ds.currentQuestionIdx--;
                ds.phase = 'question';
                ds.answers = {};
                ds.revealedCells = [];
                ds.revealedLetters = [];
                ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
                ds.optionsRevealed = false; ds.optionsRevealedAt = null;
                initIdentidadState(ds); initAclaraState(ds); initAbiertaState(ds); initPictionaryState(state);
                if (isNoTimerRound(ds)) {
                    ds.timer = { total: 0, remaining: 0, running: false };
                } else {
                    const cfg = getQuestionConfig(state);
                    ds.timer = { total: cfg.time, remaining: cfg.time, running: false };
                }
                state.pulsadorActivo = false;
                state.colaPulsador = [];
                // Pregunta ya puntuada: se muestra con su resultado, sin volver a responder ni puntuar
                restoreQuestionResult(state);
                broadcastDirector(io, gameId, state);
            }
        });

        socket.on('director:start_timer', () => {
            const ds = state.director;
            if (ds.phase !== 'question' || isNoTimerRound(ds)) return;
            // Respuesta abierta: el tiempo arranca con «Abrir respuestas»; aquí solo se reanuda
            if (ds.abierta && ds.abierta.step !== 'open') return;
            // Pictionary: el tiempo arranca con «Empezar a dibujar»; aquí solo se reanuda
            if (ds.pictionary && ds.pictionary.step !== 'drawing') return;
            if (ds.pictionary) ds.pictionary.pausedByBuzz = false;
            clearPreCountdown(state);
            if (ds.timer.running || ds.timer.remaining <= 0) return;
            ds.timer.running = true;
            // Al arrancar el tiempo se muestran las opciones/elementos a los equipos
            if (ds.currentRound && ['multirespuesta', 'precio', 'boom', 'identidad'].includes(ds.currentRound.type)) {
                if (!ds.optionsRevealed) ds.optionsRevealedAt = Date.now();
                ds.optionsRevealed = true;
            }
            startQuestionTimer(state, gameId, io);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:stop_timer', () => {
            stopTimer(state, gameId, io);
            if (state.director.pictionary) state.director.pictionary.pausedByBuzz = false; // pausa del coordinador: no se reanuda sola
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:extend_timer', (data) => {
            if (isNoTimerRound(state.director)) return;
            const secs = Math.max(1, Math.min(120, Number(data && data.seconds) || 10));
            state.director.timer.remaining += secs;
            state.director.timer.total += secs;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reveal_answer', () => {
            // Solo con una pregunta en curso (antes, una R a destiempo revelaba y puntuaba)
            if (state.director.phase !== 'question') return;
            stopTimer(state, gameId, io);
            finalizeQuestion(state);
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
            picResume();
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

        // Adivina la imagen e Imagen que se aclara: mostrar/ocultar la respuesta en la pantalla
        // (con {visible} se fija; sin él, alterna)
        socket.on('director:image_toggle_answer', (data) => {
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q) return;
            const answer = (q.content && q.content.answer) || '';
            if (!answer) return;
            ds.imagePuzzle.answerVisible = (data && typeof data.visible === 'boolean') ? data.visible : !ds.imagePuzzle.answerVisible;
            ds.imagePuzzle.answerText = ds.imagePuzzle.answerVisible ? answer : '';
            io.to(roomOf(gameId)).emit('game:image_answer_updated', { visible: ds.imagePuzzle.answerVisible, answer: answer });
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ IDENTIDAD REVEAL ═══════════════════════

        // ── Imagen que se aclara: empezar/seguir, pausar y nitidez a mano ──
        const aclaraOpenBuzzer = () => {
            if (state.pulsadorActivo) return;
            state.pulsadorActivo = true;
            state.colaPulsador = [];
            state.buzzerOpenedAt = Date.now();
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: true, cola: [] });
        };
        socket.on('director:aclara_play', () => {
            const ds = state.director;
            if (!ds.aclara || ds.phase !== 'question' || ds.aclara.running) return;
            const lvl = aclaraLevel(ds);
            if (lvl >= 1) return;
            ds.aclara.level = lvl; ds.aclara.running = true; ds.aclara.since = Date.now();
            aclaraOpenBuzzer();
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:aclara_pause', () => {
            const ds = state.director;
            if (!ds.aclara || !ds.aclara.running) return;
            aclaraPause(ds);
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:aclara_set', (data) => {
            const ds = state.director;
            const lvl = Number(data && data.level);
            if (!ds.aclara || ds.phase !== 'question' || !isFinite(lvl)) return;
            ds.aclara.level = Math.max(0, Math.min(1, lvl)); ds.aclara.running = false;
            if (ds.aclara.level > 0) aclaraOpenBuzzer();
            broadcastDirector(io, gameId, state);
        });

        // Código para pasar un equipo a otro iPad: 6 caracteres, 10 minutos, un solo uso
        socket.on('director:recovery_code', (data) => {
            const eq = state.equipos.find(e => e.id === (data && data.teamId));
            if (!eq) return;
            if (!state._recovery) state._recovery = {};
            const now = Date.now();
            for (const [k, v] of Object.entries(state._recovery)) if (v.exp < now || v.teamId === eq.id) delete state._recovery[k];
            const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para dictarlo sin dudas
            let code;
            do { code = Array.from(require('crypto').randomBytes(6)).map(b => ALPH[b % ALPH.length]).join(''); } while (state._recovery[code]);
            state._recovery[code] = { teamId: eq.id, exp: now + 10 * 60 * 1000 };
            const gRow = db.prepare('SELECT access_code FROM games WHERE id = ?').get(gameId);
            socket.emit('director:recovery_code', { teamId: eq.id, team: eq.nombre, code, gameId, pass: auth.gamePass(gameId, gRow && gRow.access_code), minutes: 10 });
        });

        // ── Modo sin pantalla y sonido ──
        socket.on('director:set_no_screen', (data) => {
            const on = !!(data && data.on);
            if (state.director.noScreen === on) return;
            state.director.noScreen = on;
            logAction(state, { action: 'no_screen', on });
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:set_audio', (data) => {
            const where = data && data.where === 'ipads' ? 'ipads' : 'sala';
            if (state.director.audioOn === where) return;
            state.director.audioOn = where;
            logAction(state, { action: 'audio', where });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:get_log', () => {
            socket.emit('director:log', { log: state.director.bonoLog || [], count: state.director.logCount || 0 });
        });

        // ── Respuesta abierta ──
        socket.on('director:abierta_show', () => {
            const ds = state.director, a = ds.abierta;
            if (ds.phase !== 'question' || !a || a.step !== 'intro') return;
            a.step = 'shown';
            ds.optionsRevealed = true;
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:abierta_open', () => {
            const ds = state.director, a = ds.abierta;
            if (ds.phase !== 'question' || !a || (a.step !== 'intro' && a.step !== 'shown')) return;
            a.step = 'open';
            a.openedAt = Date.now();
            ds.optionsRevealed = true;
            ds.optionsRevealedAt = a.openedAt;
            if (!isNoTimerRound(ds) && ds.timer.remaining > 0) startQuestionTimer(state, gameId, io);
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:abierta_close', () => {
            const ds = state.director, a = ds.abierta;
            if (ds.phase !== 'question' || !a || a.step !== 'open') return;
            closeAbierta(state);
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:abierta_reveal', () => {
            const ds = state.director, a = ds.abierta;
            if (ds.phase !== 'question' || !a || a.step !== 'correcting') return;
            finalizeQuestion(state);
            broadcastDirector(io, gameId, state);
        });
        // Corregir (o rectificar ya revelada): { sub, teamIds, ok } — un grupo de respuestas iguales de una vez
        socket.on('director:abierta_mark', (data) => {
            const ds = state.director, a = ds.abierta;
            if (!a || !data) return;
            const revealed = ds.phase === 'answer_revealed';
            if (!(ds.phase === 'question' && a.step === 'correcting') && !revealed) return;
            const n = abiertaSubs(ds).length;
            const i = Number(data.sub);
            if (!Number.isInteger(i) || i < 0 || i >= n || !Array.isArray(data.teamIds)) return;
            const ok = !!data.ok;
            const changed = [];
            for (const tid of data.teamIds.slice(0, 200)) {
                const ans = ds.answers[tid];
                if (!ans || !ans.submitted) continue;
                if (!Array.isArray(a.marks[tid])) a.marks[tid] = Array.from({ length: n }, () => false);
                if (!!a.marks[tid][i] === ok) continue;
                a.marks[tid][i] = ok;
                changed.push(tid);
            }
            if (!changed.length) return;
            if (revealed) rectifyAbierta(state, changed, i, ok);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:reveal_next_pair', () => {
            const ds = state.director;
            // Respuesta abierta: siguiente subpregunta (los puntos, al destapar la última)
            if (ds.currentRound && ds.currentRound.type === 'abierta') {
                const a = ds.abierta, n = abiertaSubs(ds).length;
                if (ds.phase !== 'answer_revealed' || !a || a.revealStep >= n) return;
                a.revealStep++;
                if (a.revealStep >= n) applyPendingScores(state);
                io.to(roomOf(gameId)).emit('game:pair_revealed', { index: a.revealStep - 1 });
                broadcastDirector(io, gameId, state);
                return;
            }
            // Boom: siguiente posición del orden correcto
            if (ds.currentRound && ds.currentRound.type === 'boom') {
                const qb = ds.questions[ds.currentQuestionIdx];
                const n = qb && qb.content && Array.isArray(qb.content.items) ? qb.content.items.length : 0;
                if (ds.phase !== 'answer_revealed' || typeof ds.boomStep !== 'number' || ds.boomStep >= n) return;
                ds.boomStep++;
                if (ds.boomStep >= n) applyPendingScores(state); // última posición: ahora cuentan los puntos
                io.to(roomOf(gameId)).emit('game:pair_revealed', { index: ds.boomStep - 1 });
                broadcastDirector(io, gameId, state);
                return;
            }
            if (!ds.identidad) return;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q || !q.content || !q.content.pairs) return;
            if (ds.identidad.revealIndex >= q.content.pairs.length) return;
            ds.identidad.revealIndex++;
            if (ds.identidad.revealIndex >= q.content.pairs.length) applyPendingScores(state); // última pareja: ahora cuentan los puntos
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
            // El acierto consume el turno del equipo en la cola: un segundo toque ya no suma
            const idx = state.colaPulsador.findIndex(p => p.id === data.teamId);
            if (idx === -1) return;
            const qEntry = state.colaPulsador[idx];
            state.colaPulsador.splice(idx, 1);
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            const cfg = getQuestionConfig(state);
            // Bonus por rapidez solo en pruebas con temporizador (ruleta e imagen fija: puntos base)
            const bonus = isNoTimerRound(ds) ? 0 : timeBonus(cfg, ds, typeof qEntry.rem === 'number' ? qEntry.rem : ds.timer.remaining);
            // Imagen que se aclara: vale según lo nítida que estaba cuando pulsó
            const won = (ds.aclara && typeof qEntry.pts === 'number') ? qEntry.pts : cfg.basePoints + bonus;
            if (!ds.scores[data.teamId]) ds.scores[data.teamId] = 0;
            ds.scores[data.teamId] += won;
            // Con un acierto la pregunta está resuelta: se cierra el pulsador, se vacía la cola (si
            // no, el siguiente aparecería como «primero» y con turno) y se revela la respuesta.
            // El coordinador pasa a la siguiente cuando quiera.
            ds.buzzerWinner = data.teamId;
            ds.buzzerPoints = won;
            logAction(state, { action: 'correct', team: teamName(state, data.teamId), pts: won });
            // Pictionary: el equipo que dibujaba se lleva sus puntos (si la ronda los da)
            const pic = ds.pictionary;
            if (pic && pic.mode === 'equipos' && pic.drawer && pic.drawer !== data.teamId && state.equipos.some(e => e.id === pic.drawer)) {
                const dp = picCfg(ds).drawerPoints;
                if (dp > 0) {
                    if (!ds.scores[pic.drawer]) ds.scores[pic.drawer] = 0;
                    ds.scores[pic.drawer] += dp;
                    pic.drawerPts = dp;
                    logAction(state, { action: 'pic_drawer', team: teamName(state, pic.drawer), pts: dp });
                }
            }
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: false, cola: [] });
            io.to(roomOf(gameId)).emit('actualizar_pulsador_lista', state.colaPulsador);
            stopTimer(state, gameId, io);
            finalizeQuestion(state);
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
            logAction(state, { action: 'wrong', team: teamName(state, data.teamId), pts: cfg.penalty > 0 ? -cfg.penalty : 0 });
            // Un equipo que falla no puede volver a pulsar en esta pregunta
            if (!ds.buzzerFailed) ds.buzzerFailed = [];
            if (!ds.buzzerFailed.includes(data.teamId)) ds.buzzerFailed.push(data.teamId);
            if (ds.aclara && ds.phase === 'question' && !state.colaPulsador.length && aclaraMode(ds) === 'auto' && aclaraLevel(ds) < 1) {
                ds.aclara.running = true; ds.aclara.since = Date.now();
            }
            picResume();
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
            if (pts !== 0) logAction(state, { action: 'points', team: teamName(state, data.teamId), pts });
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:toggle_scoreboard', () => {
            state.director.scoreboardVisible = !state.director.scoreboardVisible;
            if (state.director.scoreboardVisible) { state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; }
            broadcastDirector(io, gameId, state);
        });
        // Legacy: also support show_scoreboard as toggle
        socket.on('director:show_scoreboard', () => {
            state.director.scoreboardVisible = !state.director.scoreboardVisible;
            if (state.director.scoreboardVisible) { state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; }
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:toggle_qr', () => {
            state.director.qrVisible = !state.director.qrVisible;
            state.director.qrPass = state.director.qrVisible ? auth.gamePassFor(gameId) : null;
            if (state.director.qrVisible) { state.director.scoreboardVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; }
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:toggle_premio_anuncio', () => {
            state.director.premioAnuncioVisible = !state.director.premioAnuncioVisible;
            if (state.director.premioAnuncioVisible) { state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioGanadorVisible = false; }
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:toggle_premio_ganador', () => {
            state.director.premioGanadorVisible = !state.director.premioGanadorVisible;
            if (state.director.premioGanadorVisible) { state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioAnuncioVisible = false; }
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:show_waiting', () => { rememberResume(state); stopTimer(state, gameId, io); state.director.phase = 'waiting'; state.director.menuLevel = null; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; broadcastDirector(io, gameId, state); });
        socket.on('director:show_lobby', () => { stopTimer(state, gameId, io); state.director.phase = 'lobby'; state.director.menuLevel = null; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; broadcastDirector(io, gameId, state); });
        socket.on('director:show_home', () => { rememberResume(state); stopTimer(state, gameId, io); state.director.phase = 'lobby'; state.director.menuLevel = 'home'; state.director.selectedCategory = null; state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; broadcastDirector(io, gameId, state); });
        // Volver a la pregunta que estaba en curso antes de 'Espera' o 'Home'
        socket.on('director:resume_question', () => {
            const ds = state.director;
            if (!ds.resumePhase || !ds.currentRound || ds.currentQuestionIdx < 0 || !ds.questions[ds.currentQuestionIdx]) return;
            ds.phase = ds.resumePhase;
            ds.resumePhase = null;
            ds.menuLevel = null;
            ds.selectedCategory = null;
            broadcastDirector(io, gameId, state);
        });
        socket.on('director:select_category', (data) => { if (!data || !data.category) return; state.director.phase = 'lobby'; state.director.menuLevel = 'category'; state.director.selectedCategory = data.category; state.director.scoreboardVisible = false; state.director.qrVisible = false; state.director.premioAnuncioVisible = false; state.director.premioGanadorVisible = false; broadcastDirector(io, gameId, state); });

        socket.on('director:block_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) { eq.bloqueado = true; eq.descongelaEn = (state.director.phase === 'question') ? 1 : 2; io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos); if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); logAction(state, { action: 'freeze', team: eq.nombre }); }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_team', (data) => {
            if (!data || !data.teamId) return;
            const eq = state.equipos.find(e => e.id === data.teamId);
            if (eq) { eq.bloqueado = false; eq.descongelaEn = 0; io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos); if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); logAction(state, { action: 'unfreeze', team: eq.nombre }); }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:block_all', () => {
            // Congela a cada equipo (no un bloqueo global aparte): así descongelar uno a uno
            // desde la barra de equipos funciona y nunca queda el pulsador muerto sin aviso.
            state.equipos.forEach(eq => { eq.bloqueado = true; if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); });
            state.bloqueoGlobal = false;
            logAction(state, { action: 'freeze_all' });
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:unblock_all', () => {
            state.equipos.forEach(eq => { eq.bloqueado = false; if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq); });
            state.bloqueoGlobal = false;
            logAction(state, { action: 'unfreeze_all' });
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
            // Doble toque / dos coordinadores: solo la primera pulsación cuenta
            if (ds.phase !== 'question' || ds.optionsRevealed || state._preCountdownHandle || ds.abierta) return;
            ds.optionsRevealed = true;
            ds.optionsRevealedAt = Date.now();
            // Cuenta atrás de 5 s antes de que arranque solo el temporizador
            ds.preCountdown = 5;
            broadcastDirector(io, gameId, state);
            const handle = setInterval(() => {
                if (state._preCountdownHandle !== handle) { clearInterval(handle); return; }
                ds.preCountdown = Math.max(0, (ds.preCountdown || 0) - 1);
                if (ds.preCountdown <= 0) {
                    clearPreCountdown(state);
                    if (ds.phase === 'question' && !ds.timer.running && ds.timer.remaining > 0) {
                        startQuestionTimer(state, gameId, io);
                    }
                }
                broadcastDirector(io, gameId, state);
            }, 1000);
            state._preCountdownHandle = handle;
        });

        socket.on('director:toggle_team_results', () => {
            state.director.showTeamResults = !state.director.showTeamResults;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:complete_round', (data) => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            if (!data || !data.roundId) return;
            const ds = state.director;
            if (ds.completedRounds.indexOf(data.roundId) === -1) {
                ds.completedRounds.push(data.roundId);
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:finish_round', () => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            finalizarRonda(state, io, gameId);
        });

        socket.on('director:finish_with_premio', (data) => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            const r = resolverPremioAsignado(state, data, io, gameId);
            finalizarRonda(state, io, gameId);
            state.director.premioGanadorExtra = r.extra;
            state.director.premioGanadorTeam = r.team;
            state.director.premioGanadorTipo = r.tipo;
            state.director.premioGanadorVisible = true;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:go_home', () => {
            applyPendingScores(state); // puntos de Boom/Identidad sin terminar de revelar
            const ds = state.director;
            ds.currentRoundId = null;
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
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
            ds.bonoLog = []; ds.logCount = 0; ds.pendingScores = null;
            logAction(state, { action: 'reset', what: 'session' });
            // Reset round/question state
            ds.currentRoundId = null;
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.phase = 'lobby';
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
            ds.identidad = null;
            ds.optionsRevealed = false; ds.optionsRevealedAt = null;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            ds.questionResults = {}; ds.abiertaWip = {};
            ds.picDone = []; ds.picRank = {}; ds.picLast = null; state._picDrawings = null;
            ds.premioAnuncioVisible = false; ds.premioGanadorVisible = false; ds.premioGanadorTeam = null; ds.premioGanadorTipo = null; ds.premioGanadorExtra = null;
            stopTimer(state, gameId, io);
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            // Los equipos siguen conectados, pero sin bonos ni congelaciones de la partida anterior
            state.bloqueoGlobal = false;
            state.equipos.forEach(eq => {
                eq.bonos = []; eq.bloqueado = false; eq.descongelaEn = 0;
                if (eq.socketId) io.to(eq.socketId).emit('update_mi_equipo', eq);
            });
            io.to(roomOf(gameId)).emit('actualizar_admin_equipos', state.equipos);
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
            ds.bonoLog = []; ds.logCount = 0; ds.pendingScores = null;
            ds.currentRoundId = null;
            ds.currentRound = null; // (antes de registrar: el reinicio no pertenece a ninguna ronda)
            logAction(state, { action: 'reset', what: 'full' });
            ds.currentRound = null;
            ds.questions = [];
            ds.currentQuestionIdx = -1;
            ds.phase = 'lobby';
            ds.menuLevel = null;
            ds.selectedCategory = null;
            ds.answers = {};
            ds.revealedCells = [];
            ds.revealedLetters = [];
            ds.rouletteRevealed = []; ds.rouletteSolved = false; ds.roulettePanelVisible = false; ds.imagePuzzle = { questionId: null, revealedTiles: [], answerVisible: false }; ds.karaoke = null; ds.buzzerFailed = []; ds.buzzerWinner = null; ds.buzzerPoints = 0; ds.boomStep = null; ds.aclara = null; ds.abierta = null; ds.pictionary = null; ds.videoState = null; ds.resumePhase = null; ds.questionEpoch = (ds.questionEpoch || 0) + 1;
            ds.identidad = null;
            ds.optionsRevealed = false; ds.optionsRevealedAt = null;
            ds.lastQuestionScores = {};
            ds.showTeamResults = false;
            ds.scoreboardVisible = false;
            ds.qrVisible = false;
            ds.questionResults = {}; ds.abiertaWip = {};
            ds.picDone = []; ds.picRank = {}; ds.picLast = null; state._picDrawings = null;
            ds.premioAnuncioVisible = false; ds.premioGanadorVisible = false; ds.premioGanadorTeam = null; ds.premioGanadorTipo = null; ds.premioGanadorExtra = null;
            state.bloqueoGlobal = false;
            // Clear teams from memory
            state.equipos = [];
            state.juegoIniciado = false;
            state.pulsadorActivo = false;
            state.colaPulsador = [];
            // Notify all players to reset their local state
            io.to(roomOf(gameId)).emit('game:reset_full');
            broadcastDirector(io, gameId, state);
        });

        // ═══════════════════════ PICTIONARY ═══════════════════════

        // Tras un fallo (o al vaciar la cola) el tiempo que se paró al pulsar vuelve a correr
        function picResume() {
            const ds = state.director, p = ds.pictionary;
            if (!p || !p.pausedByBuzz || ds.phase !== 'question' || p.step !== 'drawing' || state.colaPulsador.length) return;
            p.pausedByBuzz = false;
            if (!ds.timer.running && ds.timer.total > 0 && ds.timer.remaining > 0) startQuestionTimer(state, gameId, io);
        }
        // ¿Puede dibujar esta conexión ahora?
        function picCanDraw() {
            const ds = state.director, p = ds.pictionary;
            if (ds.phase !== 'question' || !p || p.step !== 'drawing') return false;
            if (p.mode === 'ipad') return !!socket.isPad && state._padSocketId === socket.id;
            return !!socket.equipoId && socket.equipoId === p.drawer;
        }
        const picRelay = (ev, data) => io.to(`screens:${gameId}`).to(`directors:${gameId}`).emit(ev, data);

        // Coordinador: elegir quién dibuja (antes de empezar)
        socket.on('director:pic_set_drawer', (data) => {
            const ds = state.director, p = ds.pictionary;
            if (ds.phase !== 'question' || !p || p.step !== 'setup' || p.mode !== 'equipos') return;
            const eq = state.equipos.find(e => e.id === (data && data.teamId));
            if (!eq) return;
            p.drawer = eq.id;
            broadcastDirector(io, gameId, state);
        });
        // Coordinador: «Empezar a dibujar» — la palabra llega a quien dibuja, se abre el pulsador y corre el tiempo
        socket.on('director:pic_start', () => {
            const ds = state.director, p = ds.pictionary;
            if (ds.phase !== 'question' || !p || p.step !== 'setup') return;
            if (p.mode === 'equipos') {
                if (!state.equipos.some(e => e.id === p.drawer)) return;
                picMarkDrawn(state, p.drawer);
            }
            p.step = 'drawing';
            p.pausedByBuzz = false;
            state.pulsadorActivo = true;
            state.colaPulsador = [];
            state.buzzerOpenedAt = Date.now();
            ds.optionsRevealed = true;
            ds.optionsRevealedAt = Date.now();
            io.to(roomOf(gameId)).emit('estado_pulsador_cambio', { activo: true, cola: [] });
            if (!isNoTimerRound(ds) && ds.timer.remaining > 0) startQuestionTimer(state, gameId, io);
            logAction(state, { action: 'pic_start', team: p.mode === 'equipos' ? teamName(state, p.drawer) : null });
            sendPicWord(picDrawerSocket(state), state);
            broadcastDirector(io, gameId, state);
        });
        // Coordinador: QR de la pizarra fija
        socket.on('director:pic_pad_link', () => {
            socket.emit('director:pic_pad_link', { gameId, pass: auth.gamePassFor(gameId), key: auth.padKey(gameId) });
        });

        // Pizarra fija: el iPad abre /play/pizarra.html con la llave del QR
        socket.on('pad:join', (data) => {
            if (!auth.verifyPadKey(gameId, data && data.key)) { socket.emit('pad:rejected'); return; }
            const prev = state._padSocketId && state._padSocketId !== socket.id && io.sockets.sockets.get(state._padSocketId);
            if (prev) { prev.isPad = false; prev.emit('pad:replaced'); prev.disconnect(true); }
            socket.isPad = true;
            socket.join(roomOf(gameId));
            state._padSocketId = socket.id;
            state.director.padConnected = true;
            state._gameTheme = loadGameTheme(gameId);
            socket.emit('pad:ok');
            emitPlayerSync(socket, state);
            if (state.director.pictionary && state.director.pictionary.mode === 'ipad') sendPicWord(socket, state);
            broadcastDirector(io, gameId, state);
        });

        // Trazos: { k: pregunta, s: id del trazo, n: trazo nuevo, c: color, w: grosor, p: [x,y,…] en 0-10000 }
        socket.on('pic:stroke', (d) => {
            if (!d || !picCanDraw()) return;
            const b = picBoard(state);
            if (!b || d.k !== b.key) return;
            const p = d.p;
            if (!Array.isArray(p) || !p.length || p.length % 2 || p.length > PIC_MAX_CHUNK) return;
            if (!p.every(v => Number.isInteger(v) && v >= 0 && v <= 10000)) return;
            const sid = Number(d.s), c = Number(d.c), w = Number(d.w);
            if (!Number.isInteger(sid) || sid < 0 || sid > 1e9 || !Number.isInteger(c) || c < 0 || c > 9 || !Number.isInteger(w) || w < 0 || w > 3) return;
            if (b.size + p.length > PIC_MAX_POINTS) { socket.emit('pic:full_board'); return; }
            let st = b.strokes[b.strokes.length - 1];
            const isNew = !!d.n || !st || st.s !== sid;
            if (isNew) { st = { s: sid, c, w, p: [] }; b.strokes.push(st); }
            for (const v of p) st.p.push(v);
            b.size += p.length;
            b.seq++;
            picRelay('pic:chunk', { k: b.key, q: b.seq, s: sid, c: st.c, w: st.w, n: isNew, p });
        });
        socket.on('pic:undo', (d) => {
            if (!d || !picCanDraw()) return;
            const b = picBoard(state);
            if (!b || d.k !== b.key || !b.strokes.length) return;
            const st = b.strokes.pop();
            b.size -= st.p.length;
            b.seq++;
            picRelay('pic:op', { k: b.key, q: b.seq, op: 'undo' });
        });
        socket.on('pic:clear', (d) => {
            if (!d || !picCanDraw()) return;
            const b = picBoard(state);
            if (!b || d.k !== b.key) return;
            b.strokes = []; b.size = 0;
            b.seq++;
            picRelay('pic:op', { k: b.key, q: b.seq, op: 'clear' });
        });
        // El dibujo entero (al entrar, al volver de un corte o si se ha perdido un trozo)
        socket.on('pic:get', () => {
            if (!(socket.hasPass || socket.isStaff || socket.isScreen || socket.isPad)) return;
            const b = picBoard(state);
            socket.emit('pic:full', b ? { k: b.key, q: b.seq, strokes: b.strokes } : { k: questionKeyOf(state.director), q: 0, strokes: [] });
        });

        // ─── Karaoke handlers ───
        socket.on('director:karaoke_start', (data) => {
            if (!data || !data.teamsByColor) return;
            const ds = state.director;
            const q = ds.questions[ds.currentQuestionIdx];
            if (!q || !ds.currentRound || ds.currentRound.type !== 'karaoke') {
                socket.emit('karaoke:error', { msg: 'La ronda actual no es de tipo karaoke' }); return;
            }
            const content = q.content || {};
            if (state.equipos.length < 4) {
                socket.emit('karaoke:error', { msg: 'Se requieren al menos 4 equipos' }); return;
            }
            const configColors = content.colors || [];
            const tbc = data.teamsByColor;
            // Validate all keys are valid colors
            for (const color of Object.keys(tbc)) {
                if (configColors.indexOf(color) === -1) {
                    socket.emit('karaoke:error', { msg: 'Color no válido: ' + color }); return;
                }
            }
            // Validate all teams assigned exactly once
            const allTeamIds = state.equipos.map(e => e.id);
            const assignedIds = [];
            for (const color of Object.keys(tbc)) {
                if (!Array.isArray(tbc[color])) { socket.emit('karaoke:error', { msg: 'teamsByColor[' + color + '] no es un array' }); return; }
                for (const tid of tbc[color]) assignedIds.push(tid);
            }
            const assignedSet = new Set(assignedIds);
            if (assignedSet.size !== assignedIds.length) {
                socket.emit('karaoke:error', { msg: 'Hay equipos asignados a más de un color' }); return;
            }
            for (const tid of allTeamIds) {
                if (!assignedSet.has(tid)) { socket.emit('karaoke:error', { msg: 'Equipo sin asignar: ' + tid }); return; }
            }
            // Parse lyrics into blocks
            const blocks = (content.lyrics || '').split(/^\s*---\s*$/m).map(b => b.trim()).filter(b => b.length > 0);
            if (blocks.length === 0) {
                socket.emit('karaoke:error', { msg: 'La letra no contiene bloques válidos' }); return;
            }
            // Initialize karaoke state
            const colorParticipation = {};
            configColors.forEach(c => { colorParticipation[c] = 0; });
            ds.karaoke = {
                blocks,
                blockIdx: -1,
                activeCombo: null,
                history: [],
                colorParticipation,
                teamsByColor: tbc,
                finished: false,
                winnerColor: null
            };
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:karaoke_advance', (data) => {
            if (!data || !data.combo) return;
            const ds = state.director;
            const k = ds.karaoke;
            if (!k) { socket.emit('karaoke:error', { msg: 'Karaoke no iniciado' }); return; }
            if (k.finished) { socket.emit('karaoke:error', { msg: 'La canción ya ha terminado' }); return; }
            const q = ds.questions[ds.currentQuestionIdx];
            const configColors = (q && q.content && q.content.colors) || [];
            const combo = data.combo;
            if (!Array.isArray(combo)) { socket.emit('karaoke:error', { msg: 'Combo inválido' }); return; }
            // Validate combo colors
            for (const c of combo) { if (configColors.indexOf(c) === -1) { socket.emit('karaoke:error', { msg: 'Color no válido en combo: ' + c }); return; } }
            if (new Set(combo).size !== combo.length) { socket.emit('karaoke:error', { msg: 'Colores duplicados en combo' }); return; }
            // Apply advance
            if (k.blockIdx >= k.blocks.length - 1) {
                k.finished = true;
                k.activeCombo = combo;
            } else {
                k.blockIdx++;
                k.activeCombo = combo;
                k.history.push(combo);
                for (const c of combo) k.colorParticipation[c]++;
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:karaoke_color_only', (data) => {
            if (!data || !data.combo) return;
            const ds = state.director;
            const k = ds.karaoke;
            if (!k) { socket.emit('karaoke:error', { msg: 'Karaoke no iniciado' }); return; }
            if (k.finished) { socket.emit('karaoke:error', { msg: 'La canción ya ha terminado' }); return; }
            if (k.blockIdx < 0) { socket.emit('karaoke:error', { msg: 'Primero avanza al menos un bloque' }); return; }
            const q = ds.questions[ds.currentQuestionIdx];
            const configColors = (q && q.content && q.content.colors) || [];
            const combo = data.combo;
            if (!Array.isArray(combo)) { socket.emit('karaoke:error', { msg: 'Combo inválido' }); return; }
            for (const c of combo) { if (configColors.indexOf(c) === -1) { socket.emit('karaoke:error', { msg: 'Color no válido en combo: ' + c }); return; } }
            if (new Set(combo).size !== combo.length) { socket.emit('karaoke:error', { msg: 'Colores duplicados en combo' }); return; }
            k.activeCombo = combo;
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:karaoke_auto', () => {
            const ds = state.director;
            const k = ds.karaoke;
            if (!k) { socket.emit('karaoke:error', { msg: 'Karaoke no iniciado' }); return; }
            if (k.finished) { socket.emit('karaoke:error', { msg: 'La canción ya ha terminado' }); return; }
            const q = ds.questions[ds.currentQuestionIdx];
            const configColors = (q && q.content && q.content.colors) || [];
            const combo = computeKaraokeAutoCombo(k, configColors);
            if (k.blockIdx >= k.blocks.length - 1) {
                k.finished = true;
                k.activeCombo = combo;
            } else {
                k.blockIdx++;
                k.activeCombo = combo;
                k.history.push(combo);
                for (const c of combo) k.colorParticipation[c]++;
            }
            broadcastDirector(io, gameId, state);
        });

        socket.on('director:karaoke_award', (data) => {
            if (!data || !data.winnerColor) return;
            const ds = state.director;
            const k = ds.karaoke;
            if (!k) { socket.emit('karaoke:error', { msg: 'Karaoke no iniciado' }); return; }
            if (!k.finished) { socket.emit('karaoke:error', { msg: 'La canción no ha terminado aún' }); return; }
            if (k.winnerColor) { socket.emit('karaoke:error', { msg: 'Los puntos de esta canción ya se repartieron' }); return; }
            const q = ds.questions[ds.currentQuestionIdx];
            const configColors = (q && q.content && q.content.colors) || [];
            if (configColors.indexOf(data.winnerColor) === -1) {
                socket.emit('karaoke:error', { msg: 'Color ganador no válido: ' + data.winnerColor }); return;
            }
            const winnerTeams = k.teamsByColor[data.winnerColor];
            if (!winnerTeams || winnerTeams.length === 0) {
                socket.emit('karaoke:error', { msg: 'No hay equipos asignados al color ' + data.winnerColor }); return;
            }
            k.winnerColor = data.winnerColor;
            const basePoints = (q.content && q.content.basePoints) || 0;
            const pointsPerTeam = Math.floor(basePoints / winnerTeams.length);
            for (const teamId of winnerTeams) {
                if (!ds.scores[teamId]) ds.scores[teamId] = 0;
                ds.scores[teamId] += pointsPerTeam;
            }
            logAction(state, { action: 'karaoke', color: data.winnerColor, teams: winnerTeams.map(t => teamName(state, t)), pts: pointsPerTeam });
            broadcastDirector(io, gameId, state);
        });

        // ─── Disconnect ───
        socket.on('disconnect', () => {
            if (socket.isPad && state._padSocketId === socket.id) {
                state._padSocketId = null;
                state.director.padConnected = false;
                broadcastDirector(io, gameId, state);
            }
            if (state.director.screensPreload && state.director.screensPreload[socket.id]) {
                delete state.director.screensPreload[socket.id];
                broadcastDirector(io, gameId, state);
            }
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

module.exports = { attachSocketHandlers, gameStates, resetGameForNewSession, roundsChanged, persistAll };
