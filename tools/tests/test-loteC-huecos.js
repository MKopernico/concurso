// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteC-huecos.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote C: huecos en Identidad. Un hueco puede quedar vacío (null) y no puntúa; no se puede
// repetir una tarjeta; al reconectar el iPad recupera dónde las tenía. Boom se revela por pasos.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3205;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteC');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await res.text(); try { return { status: res.status, data: JSON.parse(txt) }; } catch { return { status: res.status, data: txt }; }
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'LoteC', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rId = await mk('Parejas', 'identidad', { time: 60, basePoints: 100, bonusMax: 0 }, [{ statement: 'Une', pairs: [0, 1, 2, 3].map(i => ({ left: { text: 'L' + i }, right: { text: 'R' + i } })) }]);
    const rBoom = await mk('Boom', 'boom', { time: 60, basePoints: 100, bonusMax: 0 }, [{ statement: 'Ordena', items: ['a', 'b', 'c'], correct_order: [0, 1, 2] }, { statement: 'Otra', items: ['x', 'y'], correct_order: [0, 1] }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const P = [];
    for (let i = 0; i < 3; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'a' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'a' + i }); P.push(p);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);

    d.emit('director:launch_round', { roundId: rId.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(400);
    const c = P[0].sync.question.content;
    // índice k que ve el iPad para la respuesta correcta de la pareja i
    const kOf = i => c.rightsCanonical.findIndex(r => r.text === 'R' + i);
    // Equipo 0: dos huecos bien, uno vacío, uno mal (con la tarjeta de otra pareja)
    const order0 = [kOf(0), kOf(1), null, kOf(2)];
    P[0].emit('player:update_order', { order: order0 }); await wait(250);
    // Reconexión: el iPad recupera sus huecos (con el vacío)
    const got = await new Promise(res => { P[0].once('game:your_order', res); P[0].emit('player:register_team', { name: 'Equipo 0', deviceId: 'a0' }); setTimeout(() => res(null), 1500); });
    check('Al reconectar recupera sus huecos, también el vacío', got && JSON.stringify(got.order) === JSON.stringify(order0) && got.submitted === false, got);
    // Repetir una tarjeta no se acepta
    P[1].emit('player:submit_order', { order: [kOf(0), kOf(0), kOf(2), kOf(3)] }); await wait(250);
    check('Una tarjeta repetida se rechaza', !(d.state.director.answers || {})[T[1]] && !(P[1].sync.answeredTeams || []).includes(T[1]));
    // Equipo 1 lo envía todo bien
    P[1].emit('player:submit_order', { order: [0, 1, 2, 3].map(kOf) }); await wait(250);
    check('Envío completo aceptado', (P[1].sync.answeredTeams || []).includes(T[1]));
    // Más huecos que parejas o índices fuera de rango: rechazado
    P[2].emit('player:update_order', { order: [kOf(0), null, null, null, null] }); await wait(150);
    P[2].emit('player:submit_order', { order: [9, null, null, null] }); await wait(200);
    check('Órdenes con huecos de más o índices falsos se rechazan', !(P[2].sync.answeredTeams || []).includes(T[2]));
    // Se acaba la pregunta: el provisional del equipo 0 cuenta (2 de 4 → 50 puntos)
    d.emit('director:reveal_answer'); await wait(500);
    const l = P[0].sync.lastQuestionScores;
    check('El hueco vacío no puntúa: 2 de 4 parejas', l[T[0]].correctCount === 2 && l[T[0]].points === 50, l[T[0]]);
    check('Su respuesta revelada conserva el hueco vacío', Array.isArray(l[T[0]].answer) && l[T[0]].answer[2] === null && l[T[0]].answer[3] === 2, l[T[0]].answer);
    check('El envío completo suma todo', l[T[1]].correct === true && l[T[1]].correctCount === 4, l[T[1]]);
    check('Quien no colocó nada no puntúa', l[T[2]].noAnswer === true || l[T[2]].points === 0, l[T[2]]);
    // ── Boom revelado por pasos
    d.emit('director:launch_round', { roundId: rBoom.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(400);
    const shownB = P[0].sync.question.content.items;
    P[0].emit('player:submit_order', { order: ['a', 'b', 'c'].map(x => shownB.indexOf(x)) }); await wait(250);
    d.emit('director:reveal_answer'); await wait(500);
    check('Boom: al acabar empieza sin nada revelado y el iPad no recibe el orden', P[0].sync.boomStep === 0 && P[0].sync.question.content.correct_order.length === 0, { step: P[0].sync.boomStep, co: P[0].sync.question.content.correct_order });
    d.emit('director:reveal_next_pair'); await wait(300);
    check('Boom: «Ir revelando» destapa la primera posición', P[0].sync.boomStep === 1 && JSON.stringify(P[0].sync.question.content.correct_order) === '[0]');
    d.emit('director:reveal_next_pair'); d.emit('director:reveal_next_pair'); await wait(300);
    d.emit('director:reveal_next_pair'); await wait(300);
    check('Boom: se detiene al llegar al final', P[0].sync.boomStep === 3 && P[0].sync.question.content.correct_order.length === 3);
    check('Boom: los puntos se suman al acabar (una vez)', d.state.director.scores[T[0]] === 150, d.state.director.scores[T[0]]);
    cmd('director:next_question'); await wait(300);
    check('Boom: la siguiente pregunta vuelve a ocultar', P[0].sync.boomStep === null && P[0].sync.phase === 'question');
    cmd('director:prev_question'); await wait(400);
    check('Boom: volver a una ya puntuada la muestra completa', P[0].sync.phase === 'answer_revealed' && P[0].sync.boomStep === 3 && P[0].sync.question.content.correct_order.length === 3, { ph: P[0].sync.phase, st: P[0].sync.boomStep });

    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
