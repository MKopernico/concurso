// Utilidades compartidas por las pruebas largas (soak-test.js y chaos-test.js):
// servidor propio con BD temporal + sonda, coordinador simulado, generador de preguntas de los
// 10 tipos y cálculo independiente de la puntuación esperada (para comprobar que el marcador cuadra).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function until(cond, timeoutMs = 15000, step = 10) { const t0 = now(); while (!cond()) { if (now() - t0 > timeoutMs) return false; await wait(step); } return true; }

function stats(arr) {
    if (!arr.length) return { n: 0, p50: null, p95: null, max: null, avg: null };
    const a = arr.slice().sort((x, y) => x - y);
    const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
    return { n: a.length, p50: p(0.5), p95: p(0.95), max: a[a.length - 1], avg: Math.round(a.reduce((s, v) => s + v, 0) / a.length) };
}
const fmtStats = (s) => s.n ? `p50 ${s.p50} ms · p95 ${s.p95} ms · máx ${s.max} ms (${s.n})` : 'sin datos';
const MB = (b) => (b / 1048576).toFixed(1) + ' MB';
const KB = (b) => (b / 1024).toFixed(1) + ' KB';

// ───────────────── Servidor de prueba con sonda ─────────────────
class TestServer {
    constructor(port, name) {
        this.port = port;
        this.B = `http://127.0.0.1:${port}`;
        this.DATA = path.join(os.tmpdir(), 'gameshow-testdata-' + name);
        this.PW = 'pruebas-' + crypto.randomBytes(6).toString('hex');
        this.cookie = '';
        this.stderr = [];
        this._pending = new Map();
        this._seq = 0;
    }
    async start() {
        fs.rmSync(this.DATA, { recursive: true, force: true });
        this.proc = spawn(process.execPath, ['--expose-gc', '--require', path.join(__dirname, 'probe.js'), 'server.js'], {
            cwd: REPO,
            env: { ...process.env, PORT: String(this.port), GAMESHOW_DATA_DIR: this.DATA, ADMIN_PASSWORD: this.PW },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        this.proc.stdout.on('data', () => {});
        this.proc.stderr.on('data', d => {
            const s = String(d);
            if (/ExperimentalWarning|--trace-warnings/.test(s)) return;
            this.stderr.push(s);
            if (this.stderr.length > 200) this.stderr.shift();
        });
        this.proc.on('message', (m) => {
            if (m && m.type === 'sample' && this._pending.has(m.id)) { this._pending.get(m.id)(m); this._pending.delete(m.id); }
        });
        this.proc.on('exit', (code) => { this.exited = code; });
        for (let i = 0; i < 75; i++) { try { if ((await fetch(this.B + '/ping')).ok) return; } catch {} await wait(200); }
        throw new Error('el servidor de prueba no arrancó');
    }
    sample() {
        return new Promise((res, rej) => {
            const id = ++this._seq;
            const to = setTimeout(() => { this._pending.delete(id); rej(new Error('la sonda no responde')); }, 15000);
            this._pending.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(m.error)) : res(m.data); });
            this.proc.send({ type: 'sample', id });
        });
    }
    async api(p, opts = {}) {
        const res = await fetch(this.B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie: this.cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
        const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
        const txt = await res.text();
        try { return { status: res.status, data: JSON.parse(txt) }; } catch { return { status: res.status, data: txt }; }
    }
    login() { return this.api('/auth/login', { method: 'POST', body: { password: this.PW } }); }
    stop() { if (this.proc && this.exited === undefined) this.proc.kill(); }
}

// ───────────────── Juego con los 10 tipos de prueba ─────────────────
const ROUND_DEFS = [
    { type: 'multirespuesta', config: { time: 20, basePoints: 100, bonusMax: 50, penalty: 10 } },
    { type: 'precio', config: { time: 20, basePoints: 150, bonusMax: 50, penalty: 0 } },
    { type: 'boom', config: { time: 20, basePoints: 100, bonusMax: 30, penalty: 20 } },
    { type: 'identidad', config: { time: 25, basePoints: 90, bonusMax: 30, penalty: 10 } },
    { type: 'pulsador', config: { basePoints: 100, bonusMax: 50, penalty: 25 } },
    { type: 'ruleta', config: { basePoints: 120, bonusMax: 50, penalty: 0 } },
    { type: 'imagen', config: { basePoints: 80, bonusMax: 50, penalty: 10 } },
    { type: 'imagen_fija', config: { basePoints: 60, penalty: 0 } },
    { type: 'cancion', config: { basePoints: 70, penalty: 5 } },
    { type: 'karaoke', config: {} },
];
const TIMED = new Set(['multirespuesta', 'precio', 'boom', 'identidad']);
const PHRASES = ['LA CASA DE PAPEL', 'EL SEÑOR DE LOS ANILLOS', 'MÁS VALE TARDE QUE NUNCA', 'AL MAL TIEMPO BUENA CARA', 'EN BOCA CERRADA NO ENTRAN MOSCAS'];
let _uniq = 0;
function makeContent(type) {
    const u = (++_uniq).toString(36);
    switch (type) {
        case 'multirespuesta': {
            const correct = chance(0.25) ? [0, 1, 2, 3].filter(() => chance(0.5)).slice(0, 2) : [rnd(0, 3)];
            return { statement: 'Pregunta ' + u, options: ['A' + u, 'B' + u, 'C' + u, 'D' + u], correct: correct.length ? correct : [0] };
        }
        case 'precio': return { statement: 'Precio ' + u, correct_value: rnd(100, 1000) };
        case 'boom': return { statement: 'Ordena ' + u, items: ['uno-' + u, 'dos-' + u, 'tres-' + u, 'cuatro-' + u], correct_order: shuffle([0, 1, 2, 3]) };
        case 'identidad': return { statement: 'Empareja ' + u, pairs: [0, 1, 2].map(i => ({ left: 'L' + i + '-' + u, right: 'R' + i + '-' + u })) };
        case 'pulsador': return { statement: 'Pulsa ' + u, answer: 'resp ' + u };
        case 'ruleta': return { phrase: pick(PHRASES), hint: 'pista ' + u };
        case 'imagen': return { image: '/uploads/images/img-' + u + '.png', answer: 'IMG ' + u, grid_rows: 2, grid_cols: 3 };
        case 'imagen_fija': return { image: '/uploads/images/fija-' + u + '.png' };
        case 'cancion': return { answer: 'Canción ' + u };
        case 'karaoke': return { lyrics: 'bloque uno\n---\nbloque dos\n---\nbloque tres\n---\nbloque cuatro', numColors: 4, colors: ['rojo', 'amarillo', 'azul', 'verde'], basePoints: 200 };
    }
}

async function buildGame(srv, name, code, types = ROUND_DEFS.map(r => r.type)) {
    const g = (await srv.api('/games', { method: 'POST', body: { name, status: 'published', access_code: code } })).data;
    const rounds = {};
    const byId = new Map();
    for (const def of ROUND_DEFS.filter(d => types.includes(d.type))) {
        const r = (await srv.api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Ronda ' + def.type, type: def.type, config: def.config } })).data;
        rounds[def.type] = { id: r.id, type: def.type, config: def.config, questions: [] };
    }
    await srv.api(`/games/${g.id}/session`, { method: 'POST', body: {} });
    // Sustituye las preguntas de una ronda por otras nuevas (cada vuelta juega preguntas distintas)
    async function refreshQuestions(type, n, premioIdx = -1) {
        const r = rounds[type];
        for (const q of r.questions) await srv.api(`/questions/${q.id}`, { method: 'DELETE' });
        r.questions = [];
        for (let i = 0; i < n; i++) {
            const content = makeContent(type);
            const config = i === premioIdx ? { premio: { tipo: 'puntos', cantidad: 40 } } : undefined;
            const q = (await srv.api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content, config } })).data;
            r.questions.push({ id: q.id, content, config });
            byId.set(q.id, content);
        }
        return r.questions;
    }
    return { g, rounds, refreshQuestions, contentOf: (qid) => byId.get(qid) };
}

// ───────────────── Puntuación esperada (cálculo propio, independiente del servidor) ─────────────────
// answers: { teamId: { answer, timestamp, timerRemaining } } tal como quedaron al cerrar la pregunta.
function expectedPoints(type, content, cfg, answers, timerTotal) {
    const out = {};
    const base = cfg.basePoints ?? 100, bonusMax = cfg.bonusMax ?? 50, penalty = cfg.penalty ?? 0;
    const bonus = (tr) => timerTotal > 0 ? Math.floor(bonusMax * (tr / timerTotal)) : 0;
    const entries = Object.entries(answers || {});
    if (type === 'multirespuesta') {
        const ok = new Set(content.correct);
        for (const [t, a] of entries) {
            const picked = Array.isArray(a.answer) ? a.answer : [a.answer];
            out[t] = (picked.length >= 1 && picked.every(x => ok.has(x))) ? base + bonus(a.timerRemaining) : -penalty;
        }
    } else if (type === 'precio') {
        const cv = Number(content.correct_value);
        let best = null;
        for (const [t, a] of entries) {
            const v = Number(a.answer);
            if (isNaN(v) || v > cv) continue;
            if (!best || cv - v < best.d || (cv - v === best.d && a.timestamp < best.ts)) best = { t, d: cv - v, ts: a.timestamp, tr: a.timerRemaining };
        }
        for (const [t] of entries) out[t] = 0;
        if (best) out[best.t] = base + bonus(best.tr);
    } else if (type === 'boom') {
        const want = JSON.stringify(content.correct_order);
        for (const [t, a] of entries) out[t] = JSON.stringify(Array.isArray(a.answer) ? a.answer : []) === want ? base + bonus(a.timerRemaining) : -penalty;
    } else if (type === 'identidad') {
        const n = content.pairs.length;
        for (const [t, a] of entries) {
            const sub = Array.isArray(a.answer) ? a.answer : [];
            let c = 0; for (let i = 0; i < n; i++) if (sub[i] === i) c++;
            const prop = Math.floor(base * c / n);
            out[t] = c === n ? prop + bonus(a.timerRemaining) : prop - penalty;
        }
    }
    for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
    return out;
}

// ───────────────── Coordinador simulado ─────────────────
function makeDirector(srv, gameId) {
    const d = io(srv.B, { query: { gameId }, transports: ['websocket'], extraHeaders: { cookie: srv.cookie }, forceNew: true, reconnection: true });
    d.state = null; d.syncs = 0; d.syncSizes = []; d.errors = [];
    d.on('game:director_sync', st => { d.state = st; d.syncs++; if (d.syncs % 25 === 0) d.syncSizes.push(JSON.stringify(st).length); });
    d.on('connect', () => d.emit('director:join'));
    d.on('karaoke:error', e => d.errors.push('karaoke: ' + (e && e.msg)));
    d.on('auth_required', () => d.errors.push('auth_required'));
    d.D = () => d.state.director;
    // Órdenes ligadas a la pregunta actual (como hace la tablet del coordinador)
    d.cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    // Pide el estado y espera a que llegue: devuelve el tiempo de ida y vuelta (latencia del servidor)
    d.fresh = async (settle = 120) => {
        const n = d.syncs, t0 = now();
        d.emit('director:join');
        const ok = await until(() => d.syncs > n, 15000, 2);
        const rtt = now() - t0;
        if (settle) await wait(settle);
        return ok ? rtt : null;
    };
    return d;
}

// ───────────────── iPad simulado ─────────────────
// Se comporta como public/play: reconecta con player:reconnect, guarda las respuestas enviadas sin
// conexión y las manda al recuperar el equipo (si sigue la misma pregunta), las pulsaciones no.
// Opcional: retraso artificial (lag, en ms, en ambos sentidos y respetando el orden) y caos.
const QUEUEABLE = new Set(['player:submit_answer', 'player:submit_price', 'player:submit_order', 'player:update_order']);
const RESENDABLE = new Set(['player:submit_answer', 'player:submit_price', 'player:submit_order']);
const BUZZ_TYPES = new Set(['pulsador', 'ruleta', 'imagen', 'imagen_fija', 'cancion']);

// Cola con retraso que conserva el orden (como TCP): nunca adelanta un mensaje a otro anterior
function delayLine(getDelay) {
    let last = 0;
    return (fn) => {
        const d = getDelay();
        const t = Date.now();
        if (!d && last <= t) return fn();
        const at = Math.max(t + d, last);
        last = at;
        setTimeout(fn, at - t);
    };
}

class Ipad {
    constructor(srv, gameId, pass, i, opts = {}) {
        this.srv = srv; this.gameId = gameId; this.pass = pass; this.i = i;
        this.deviceId = 'ipad-' + i + '-' + crypto.randomBytes(3).toString('hex');
        this.name = 'Equipo ' + (i + 1);
        this.lag = opts.lag || 0;
        this.oracle = opts.oracle;           // qid → contenido (para saber la respuesta correcta)
        this.skill = opts.skill ?? (0.3 + Math.random() * 0.5);
        this.answerDelay = opts.answerDelay || [200, 3500];
        this.useBonos = !!opts.useBonos;
        this.chaos = opts.chaos || null;     // { midQuestion, onAnswer, onBuzz, offline:[min,max] }
        this.teamId = null; this.firstTeamId = null; this.me = null; this.ps = null;
        this.sock = null; this.pending = {};
        this.lat = { answer: [], buzz: [] };
        this.ev = { logins: 0, connects: 0, reconnectFailed: [], registerError: [], teamChanged: 0, dupQueue: 0, lostInFlight: 0, drops: 0, flushed: 0 };
        this.log = {};                        // questionKey → qué hizo este iPad en esa pregunta
        this.curKey = null;
        this.awaitAns = null; this.awaitBuzz = null;
        this.offline = false;
        this.msgs = 0;
        this.stopped = false;
    }
    jitter() { return this.lag ? Math.round(this.lag * (0.5 + Math.random())) : 0; }
    get canSend() { return !!(this.sock && this.sock.connected && this.teamId); }
    L(key) { return this.log[key] || (this.log[key] = {}); }

    connect() {
        if (this.stopped) return;
        this.offline = false;
        const s = io(this.srv.B, { query: { gameId: this.gameId, deviceId: this.deviceId, pass: this.pass }, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 10000 });
        this.sock = s;
        s._in = delayLine(() => this.jitter());
        s._out = delayLine(() => this.jitter());
        const on = (ev, fn) => s.on(ev, (...a) => { if (this.sock !== s) return; this.msgs++; s._in(() => { if (this.sock === s) fn(...a); }); });
        on('connect', () => {
            this.ev.connects++;
            // Igual que el iPad real: al conectar (o reconectar) intenta recuperar su equipo
            this.raw('player:reconnect', { deviceId: this.deviceId });
        });
        on('connect_error', () => { if (this.sock === s) this.scheduleReconnect(500, 2000); });
        on('reconnect_failed', (r) => {
            const reason = r && r.reason;
            if (reason === 'no_team' && !this.teamId) { this.raw('player:register_team', { name: this.name, deviceId: this.deviceId }); return; }
            this.ev.reconnectFailed.push(reason);
        });
        on('register_error', (e) => this.ev.registerError.push(e && e.error));
        on('login_success', (x) => {
            const id = x.miEquipo.id;
            if (this.firstTeamId && id !== this.firstTeamId) this.ev.teamChanged++;
            if (!this.firstTeamId) this.firstTeamId = id;
            this.teamId = id; this.me = x.miEquipo; this.ev.logins++; this.loggedSock = s;
            setTimeout(() => { if (this.sock === s) this.flush(); }, 300);
        });
        on('update_mi_equipo', (eq) => { if (eq && eq.id === this.teamId) this.me = eq; });
        on('actualizar_pulsador_lista', (cola) => this.onQueue(cola));
        on('estado_pulsador_cambio', (x) => { if (x && x.cola) this.onQueue(x.cola); });
        on('game:player_sync', (ps) => this.onSync(ps));
        s.on('disconnect', () => {
            if (!s._endedAt) s._endedAt = Date.now();
            if (this.sock === s && !this.offline) { this.sock = null; this.scheduleReconnect(300, 2500); }
        });
        return s;
    }
    raw(ev, data) {
        const s = this.sock;
        if (!s) return false;
        s._out(() => { if (this.sock === s && s.connected) s.emit(ev, data); else this.ev.lostInFlight++; });
        return true;
    }
    // Como emit() de public/play (incluido el reenvío automático con "ago")
    emit(ev, data) {
        const entry = { data, key: this.ps && this.ps.questionKey, at: Date.now() };
        if (RESENDABLE.has(ev)) this.lastAnswer = { ev, ...entry };
        if (this.canSend) { this.raw(ev, data); return 'sent'; }
        if (QUEUEABLE.has(ev)) { this.pending[ev] = entry; return 'queued'; }
        return 'dropped';
    }
    flush() {
        const p = this.pending; this.pending = {};
        const sent = {};
        const withAgo = (x) => ({ ...x.data, ago: Date.now() - x.at });
        for (const [ev, x] of Object.entries(p)) {
            if (this.ps && x.key === this.ps.questionKey && this.ps.phase === 'question') {
                this.raw(ev, withAgo(x)); this.ev.flushed++; sent[ev] = true;
                const l = this.L(x.key); l.flushed = true; l.sentAt = Date.now(); l.sock = this.sock;
            }
        }
        const a = this.lastAnswer, ps = this.ps;
        if (a && !sent[a.ev] && ps && this.teamId && a.key === ps.questionKey && ps.phase === 'question' && !(ps.answeredTeams || []).includes(this.teamId)) {
            this.raw(a.ev, withAgo(a)); this.ev.resent = (this.ev.resent || 0) + 1;
            const l = this.L(a.key); l.resent = true; l.sentAt = Date.now(); l.sock = this.sock;
        }
    }
    scheduleReconnect(a, b) {
        if (this.stopped || this.offline) return;
        this.offline = true;
        setTimeout(() => this.connect(), rnd(a, b));
    }
    // Corta la conexión. clean = cierre normal; drop = se cae la red (TCP cerrado);
    // zombie = la conexión queda colgada sin cerrarse (el servidor la cree viva hasta ~45 s).
    drop(mode = 'drop', offlineMs) {
        const s = this.sock;
        if (!s || this.offline) return;
        this.ev.drops++;
        this.ev['drop_' + mode] = (this.ev['drop_' + mode] || 0) + 1;
        s._endedAt = Date.now();
        this.sock = null; this.offline = true;
        this.awaitAns = null; this.awaitBuzz = null; // el tiempo desconectado no cuenta como latencia
        try {
            if (mode === 'clean') s.disconnect();
            else {
                const raw = s.io.engine.transport.ws._socket;
                if (mode === 'zombie') { raw.pause(); raw.write = () => true; setTimeout(() => { try { raw.destroy(); } catch {} s.close(); }, 60000); }
                else raw.destroy();
            }
        } catch { s.disconnect(); }
        const [a, b] = (this.chaos && this.chaos.offline) || [300, 5000];
        setTimeout(() => this.connect(), offlineMs ?? rnd(a, b));
    }
    stop() { this.stopped = true; if (this.sock) this.sock.close(); this.sock = null; }

    onQueue(cola) {
        if (!Array.isArray(cola)) return;
        const ids = cola.map(c => c.id);
        if (new Set(ids).size !== ids.length) this.ev.dupQueue++;
        if (this.awaitBuzz && ids.includes(this.teamId)) { this.lat.buzz.push(now() - this.awaitBuzz.t0); this.awaitBuzz = null; }
    }

    onSync(ps) {
        this.ps = ps;
        if (this.awaitAns && ps.questionKey === this.awaitAns.key && (ps.answeredTeams || []).includes(this.teamId)) { this.lat.answer.push(now() - this.awaitAns.t0); this.awaitAns = null; }
        if (ps.phase !== 'question' || !ps.question) return;
        const key = ps.questionKey;
        if (key !== this.curKey) {
            this.curKey = key;
            this.awaitAns = null; this.awaitBuzz = null;
            if (this.chaos && chance(this.chaos.midQuestion || 0)) setTimeout(() => this.drop(pick(['clean', 'drop', 'zombie'])), rnd(0, 8000));
            if (this.useBonos && this.me && (this.me.bonos || []).length && chance(0.25)) setTimeout(() => this.tryBono(), rnd(100, 2000));
        }
        const l = this.L(key);
        const type = ps.roundType;
        if (TIMED.has(type) && !l.scheduled) {
            const c = ps.question.content || {};
            const ready = type === 'precio' || (ps.optionsRevealed && (c.options || c.items || c.rightsCanonical));
            if (ready && chance(0.97)) { l.scheduled = true; setTimeout(() => this.answer(key), rnd(...this.answerDelay)); }
            else if (ready) l.scheduled = true;
        }
        if (BUZZ_TYPES.has(type) && ps.pulsadorActivo && !l.buzzScheduled && !(ps.buzzerFailed || []).includes(this.teamId)) {
            l.buzzScheduled = true;
            if (chance(0.85)) setTimeout(() => this.buzz(key), rnd(50, 1500));
        }
    }

    buildAnswer(type, q, c) {
        const right = chance(this.skill);
        if (type === 'multirespuesta') {
            const wrong = [0, 1, 2, 3].filter(x => !c.correct.includes(x));
            if (right || !wrong.length) return { ev: 'player:submit_answer', data: { answer: c.correct.length > 1 && chance(0.3) ? c.correct.slice() : pick(c.correct) } };
            return { ev: 'player:submit_answer', data: { answer: chance(0.2) ? [pick(wrong), pick(c.correct)] : pick(wrong) } };
        }
        if (type === 'precio') {
            const cv = Number(c.correct_value);
            return { ev: 'player:submit_price', data: { value: right ? cv - rnd(0, 150) : cv + rnd(1, 200) } };
        }
        if (type === 'boom') {
            const shown = q.content.items || [];
            const good = c.correct_order.map(ci => shown.indexOf(c.items[ci]));
            return { ev: 'player:submit_order', data: { order: right ? good : shuffle(good) } };
        }
        if (type === 'identidad') {
            const rc = q.content.rightsCanonical || [];
            const good = c.pairs.map(p => rc.indexOf(p.right));
            let order = good.slice();
            if (!right) { const a = rnd(0, 2), b = (a + rnd(1, 2)) % 3; [order[a], order[b]] = [order[b], order[a]]; }
            return { ev: 'player:submit_order', data: { order }, provisional: true };
        }
    }

    answer(key) {
        const ps = this.ps;
        if (this.stopped || !ps || ps.questionKey !== key || ps.phase !== 'question') return;
        const c = this.oracle && this.oracle(ps.question.id);
        if (!c) return;
        const a = this.buildAnswer(ps.roundType, ps.question, c);
        if (!a) return;
        const l = this.L(key);
        // Identidad: a veces solo se deja la ordenación provisional (cuenta al cerrar la pregunta)
        if (a.provisional) {
            this.emit('player:update_order', a.data);
            if (chance(0.2)) { l.provisionalOnly = true; return; }
        }
        let dropMode = null;
        if (this.chaos && chance(this.chaos.onAnswer || 0)) dropMode = chance(0.5) ? 'before' : 'after';
        if (dropMode === 'before') this.drop(pick(['clean', 'drop', 'zombie']));
        const r = this.emit(a.ev, a.data);
        l.result = r; l.sentAt = l.pressAt = Date.now(); l.sock = this.sock;
        if (r === 'sent') this.awaitAns = { key, t0: now() };
        if (dropMode === 'after') { l.droppedRightAfter = true; this.drop(pick(['clean', 'drop', 'zombie'])); }
        else if (dropMode === 'before') l.droppedBefore = true;
    }

    buzz(key) {
        const ps = this.ps;
        if (this.stopped || !ps || ps.questionKey !== key || ps.phase !== 'question' || !ps.pulsadorActivo) return;
        if (this.me && this.me.bloqueado) return;
        const l = this.L(key);
        const r = this.emit('pulsar_boton');
        l.buzz = r; l.buzzAt = Date.now(); l.buzzSock = this.sock;
        if (r === 'sent') this.awaitBuzz = { key, t0: now() };
        if (this.chaos && chance(this.chaos.onBuzz || 0)) { l.buzzDropped = true; this.drop(pick(['clean', 'drop', 'zombie'])); }
    }

    tryBono() {
        const ps = this.ps;
        if (!this.me || !ps || !this.canSend || this.me.bloqueado) return;
        const b = this.me.bonos || [];
        if (b.includes('freeze')) {
            const rivals = (ps.equipos || []).filter(e => e.id !== this.teamId && !e.bloqueado);
            if (rivals.length) this.emit('usar_bono', { tipo: 'freeze', targetId: pick(rivals).id });
        } else if (b.includes('lock_all') && chance(0.3)) this.emit('usar_bono', { tipo: 'lock_all' });
    }
}

// ───────────────── Coordinador que juega las rondas y lleva su propio marcador ─────────────────
class Coordinator {
    constructor(srv, game, d, opts = {}) {
        this.srv = srv; this.game = game; this.d = d;
        this.ledger = {};             // marcador esperado, calculado por la prueba
        this.mismatches = [];         // preguntas en las que el servidor no sumó lo esperado
        this.rtt = [];                // ida y vuelta coordinador ↔ servidor
        this.questions = 0;
        this.waitAll = opts.waitAll !== false;     // esperar a que respondan todos (si no: ventana fija)
        this.answerWindow = opts.answerWindow || [6000, 6000];
        this.buzzWindow = opts.buzzWindow || [1800, 2500];
        this.extras = !!opts.extras;  // premios, puntos a mano, volver atrás, espera, marcador, bonos
        this.onClosed = opts.onClosed || null;
        this.log = opts.log || (() => {});
    }
    D() { return this.d.state.director; }
    async fresh(settle) { const r = await this.d.fresh(settle); if (r != null) this.rtt.push(r); return r; }
    scores() { return { ...this.D().scores }; }
    add(map) { for (const [t, p] of Object.entries(map)) this.ledger[t] = (this.ledger[t] || 0) + p; }
    keyNow() { const D = this.D(); return (D.currentRoundId || '') + ':' + D.currentQuestionIdx + ':' + (D.questionEpoch || 0); }
    compare(label, before, after, exp) {
        const bad = [];
        const ids = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(exp)]);
        for (const t of ids) {
            const delta = (after[t] || 0) - (before[t] || 0);
            if (delta !== (exp[t] || 0)) bad.push({ team: t, servidor: delta, esperado: exp[t] || 0 });
        }
        if (bad.length) { this.mismatches.push({ label, bad }); this.log(`  ✗ ${label}: ${JSON.stringify(bad.slice(0, 4))}`); }
        return !bad.length;
    }

    async playRound(type, qs) {
        const d = this.d, r = this.game.rounds[type];
        d.emit('director:launch_round', { roundId: r.id });
        if (!await until(() => this.D().currentRoundId === r.id && this.D().phase === 'round_intro', 10000)) throw new Error('no se lanzó la ronda ' + type);
        await this.fresh(0);
        d.emit('director:start_round');
        if (!await until(() => this.D().phase === 'question' && this.D().currentQuestionIdx === 0, 10000)) throw new Error('no empezó la ronda ' + type);
        for (let qi = 0; qi < qs.length; qi++) {
            if (qi > 0) {
                const prev = qs[qi - 1];
                await this.fresh();
                if (prev.config && prev.config.premio) {
                    // Premio de puntos a un equipo al pasar de pregunta
                    const before = this.scores();
                    const winner = pick(this.d.state.equipos).id;
                    d.cmd('director:next_with_premio', { teamId: winner });
                    if (chance(0.3)) d.cmd('director:next_with_premio', { teamId: winner }); // doble toque: debe ignorarse
                    await until(() => this.D().currentQuestionIdx === qi, 10000);
                    await this.fresh();
                    const exp = { [winner]: prev.config.premio.cantidad };
                    this.compare(`${type} premio`, before, this.scores(), exp);
                    this.add(exp);
                } else {
                    d.cmd('director:next_question');
                    if (chance(0.2)) d.cmd('director:next_question'); // doble toque: no debe saltarse una pregunta
                    await until(() => this.D().currentQuestionIdx === qi && this.D().phase === 'question', 10000);
                    await wait(150);
                    if (this.D().currentQuestionIdx !== qi) this.mismatches.push({ label: `${type}: el doble toque saltó una pregunta`, bad: [] });
                }
            }
            await this.playQuestion(type, qs[qi], r.config);
        }
        if (this.extras && qs.length > 1 && chance(0.5)) {
            // Volver a una pregunta ya puntuada: se ve revelada y no vuelve a sumar
            await this.fresh();
            const before = this.scores();
            this.d.cmd('director:prev_question');
            await until(() => this.D().currentQuestionIdx === qs.length - 2, 8000);
            this.d.emit('director:reveal_answer');
            await wait(1500);
            await this.fresh();
            if (this.D().phase !== 'answer_revealed') this.mismatches.push({ label: `${type}: la pregunta ya jugada no se mostró revelada`, bad: [] });
            this.compare(`${type} volver atrás`, before, this.scores(), {});
        }
        d.cmd('director:finish_round');
        await until(() => this.D().phase === 'round_end', 10000);
        if (this.extras) { d.emit('director:toggle_scoreboard'); await wait(300); d.emit('director:toggle_scoreboard'); }
    }

    async playQuestion(type, q, cfg) {
        const d = this.d;
        await this.fresh();
        const before = this.scores();
        const key = this.keyNow();
        const qIdx = this.D().currentQuestionIdx;
        let exp = {};
        if (this.extras && chance(0.4)) this.giveBonos();
        if (TIMED.has(type)) {
            if (chance(0.5)) d.emit('director:reveal_options'); else d.emit('director:start_timer');
            if (chance(0.3)) d.emit('director:reveal_options'); // doble toque
            if (this.extras && chance(0.15)) setTimeout(() => d.emit('director:extend_timer', { seconds: 10 }), 800);
            const t0 = now(), win = rnd(...this.answerWindow);
            const nTeams = this.d.state.equipos.length;
            if (this.waitAll) await until(() => (this.D().answeredCount || 0) >= nTeams || now() - t0 > win, win + 1000, 50);
            else await wait(win);
            if (chance(0.2)) {
                // Se deja que se agote el tiempo: puntúa y revela el servidor solo
                await until(() => this.D().phase === 'answer_revealed', 60000, 50);
            } else d.emit('director:reveal_answer');
            const closeAt = Date.now();
            if (!await until(() => this.D().phase === 'answer_revealed', 15000)) throw new Error('la pregunta no se cerró');
            if (chance(0.2)) d.emit('director:reveal_answer'); // R a destiempo: no debe volver a puntuar
            await this.fresh(150);
            // Respuestas tal como quedaron al cerrar la pregunta (con su tiempo restante)
            const answers = this.D().answers || {};
            exp = expectedPoints(type, q.content, cfg, answers, this.D().timer.total);
            if (this.onClosed) this.onClosed({ type, q, key, closeAt, recorded: answers });
        } else if (BUZZ_TYPES.has(type)) {
            if (type === 'ruleta') { d.emit('director:show_roulette_panel'); d.emit('director:reveal_letter', { letter: 'A' }); d.emit('director:reveal_letter', { letter: 'E' }); }
            else if (type === 'imagen') { d.emit('director:image_reveal_tile', { tileIndex: 0 }); d.emit('director:image_reveal_tile', { tileIndex: 3 }); }
            else { if (type === 'imagen_fija') d.emit('director:video_command', { action: 'play' }); d.emit('director:open_buzzer'); }
            const openAt = Date.now();
            await wait(rnd(...this.buzzWindow));
            await this.fresh(150);
            const queue = this.d.state.colaPulsador.map(x => x.id);
            const readAt = Date.now();
            if (new Set(queue).size !== queue.length) this.mismatches.push({ label: `${type}: equipo repetido en la cola del pulsador`, bad: queue });
            let k = 0;
            if (queue.length >= 2 && chance(0.5)) {
                d.cmd('director:mark_wrong', { teamId: queue[0] });
                if ((cfg.penalty || 0) > 0) exp[queue[0]] = -cfg.penalty;
                k = 1;
            }
            if (queue[k]) {
                d.cmd('director:mark_correct', { teamId: queue[k] });
                if (chance(0.3)) d.cmd('director:mark_correct', { teamId: queue[k] }); // doble toque: no suma dos veces
                exp[queue[k]] = (exp[queue[k]] || 0) + cfg.basePoints;
            }
            await wait(150);
            if (type === 'ruleta') d.emit('director:solve_roulette');
            if (type === 'imagen') d.emit('director:image_toggle_answer');
            if (type === 'imagen_fija') d.emit('director:video_command', { action: 'pause' });
            d.emit('director:close_buzzer');
            d.emit('director:reveal_answer');
            if (!await until(() => this.D().phase === 'answer_revealed', 15000)) throw new Error('la pregunta no se cerró');
            if (this.onClosed) this.onClosed({ type, q, key, openAt, readAt, queue });
        } else if (type === 'karaoke') {
            const ids = shuffle(this.d.state.equipos.map(e => e.id));
            const colors = q.content.colors;
            const tbc = Object.fromEntries(colors.map(c => [c, []]));
            ids.forEach((id, n) => tbc[colors[n % colors.length]].push(id));
            d.emit('director:karaoke_start', { teamsByColor: tbc });
            await until(() => this.D().karaoke, 8000);
            for (let n = 0; n < 6 && !(this.D().karaoke && this.D().karaoke.finished); n++) { d.emit('director:karaoke_auto'); await wait(250); }
            await until(() => this.D().karaoke && this.D().karaoke.finished, 8000);
            const win = pick(colors);
            d.cmd('director:karaoke_award', { winnerColor: win });
            const errsBefore = this.d.errors.length;
            if (chance(0.3)) { d.cmd('director:karaoke_award', { winnerColor: win }); await wait(200); this.d.errors.splice(errsBefore); } // segundo reparto: el servidor lo rechaza (esperado)
            const per = Math.floor(q.content.basePoints / tbc[win].length);
            for (const t of tbc[win]) exp[t] = per;
            await wait(200);
            d.emit('director:reveal_answer');
            await until(() => this.D().phase === 'answer_revealed', 10000);
        }
        if (this.extras && chance(0.15)) {
            // Pausa en 'Espera' y vuelta a la pregunta
            d.emit('director:show_waiting'); await until(() => this.D().phase === 'waiting', 5000);
            d.emit('director:resume_question'); await until(() => this.D().phase === 'answer_revealed', 5000);
        }
        if (this.extras && chance(0.1)) {
            const t = pick(this.d.state.equipos).id, pts = pick([15, -15, 30]);
            d.emit('director:add_points', { teamId: t, points: pts });
            exp[t] = (exp[t] || 0) + pts;
        }
        if (this.extras && chance(0.5)) d.emit('director:unblock_all');
        await this.fresh(150);
        if (this.D().currentQuestionIdx !== qIdx) this.mismatches.push({ label: `${type}: la pregunta cambió sola`, bad: [] });
        this.compare(`${type} q${qIdx}`, before, this.scores(), exp);
        this.add(exp);
        this.questions++;
    }

    giveBonos() {
        const eqs = this.d.state.equipos;
        for (let n = 0; n < 3; n++) this.d.emit('admin_gestionar_bono', { equipoId: pick(eqs).id, accion: 'add', tipo: 'freeze' });
        if (chance(0.3)) this.d.emit('admin_gestionar_bono', { equipoId: pick(eqs).id, accion: 'add', tipo: 'lock_all' });
    }
}

module.exports = {
    REPO, wait, now, rnd, pick, chance, shuffle, until, stats, fmtStats, MB, KB,
    TestServer, ROUND_DEFS, TIMED, BUZZ_TYPES, buildGame, expectedPoints, makeDirector, Ipad, Coordinator,
};
