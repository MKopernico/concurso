// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteB-ensayo.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote B del ensayo: el iPad recibe lo necesario para mostrar «Respuesta correcta · Tu respuesta ·
// acertaste o no» en todas las pruebas, también al volver a una pregunta ya puntuada.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3204;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteB');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const g = (await api('/games', { method: 'POST', body: { name: 'LoteA', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rPul = await mk('Pulsa', 'pulsador', { basePoints: 100 }, [{ statement: 'P1', answer: 'x' }, { statement: 'P2', answer: 'y' }]);
    const rMul = await mk('Multi', 'multirespuesta', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: 'M', options: ['x', 'y', 'z'], correct: [1] }]);
    const rBoom = await mk('Boom', 'boom', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: 'B', items: ['a', 'b', 'c'], correct_order: [0, 1, 2] }]);
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

    // ── Pulsador: los iPads reciben quién acertó y cuántos puntos; al volver a la pregunta se conserva
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:open_buzzer'); await wait(200);
    P[2].emit('pulsar_boton'); await wait(80); P[1].emit('pulsar_boton'); await wait(300);
    cmd('director:mark_wrong', { teamId: T[2] }); await wait(200);
    cmd('director:mark_correct', { teamId: T[1] }); await wait(400);
    check('Pulsador: el iPad recibe ganador y puntos', P[0].sync.buzzerWinner === T[1] && P[0].sync.buzzerPoints === 100, { w: P[0].sync.buzzerWinner, p: P[0].sync.buzzerPoints });
    check('Pulsador: el iPad sabe quién falló', (P[2].sync.buzzerFailed || []).includes(T[2]));
    cmd('director:next_question'); await wait(300);
    check('Siguiente pregunta: ganador y puntos a cero', !P[0].sync.buzzerWinner && !P[0].sync.buzzerPoints);
    cmd('director:prev_question'); await wait(400);
    check('Volver a la pregunta puntuada: se ve revelada con su ganador', P[0].sync.phase === 'answer_revealed' && P[0].sync.buzzerWinner === T[1] && P[0].sync.buzzerPoints === 100 && (P[0].sync.buzzerFailed || []).includes(T[2]), { ph: P[0].sync.phase, w: P[0].sync.buzzerWinner });
    check('Volver no vuelve a sumar', d.state.director.scores[T[1]] === 100, d.state.director.scores[T[1]]);

    // ── Multirespuesta: el iPad recibe su respuesta y la correcta
    d.emit('director:launch_round', { roundId: rMul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(300);
    P[0].emit('player:submit_answer', { answer: [1] }); P[1].emit('player:submit_answer', { answer: [2] }); await wait(300);
    d.emit('director:reveal_answer'); await wait(500);
    const lm = P[0].sync.lastQuestionScores;
    check('Multirespuesta: respuesta propia y acierto en el iPad', JSON.stringify(lm[T[0]].answer) === '[1]' && lm[T[0]].correct === true && lm[T[1]].correct === false && lm[T[2]].noAnswer === true);
    check('Multirespuesta: el iPad ve opciones y solución al revelar', Array.isArray(P[0].sync.question.content.options) && JSON.stringify(P[0].sync.question.content.correct) === '[1]');

    // ── Boom: la respuesta del iPad llega en el orden canónico (comparable con la solución)
    d.emit('director:launch_round', { roundId: rBoom.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(300);
    const shown = P[0].sync.question.content.items; const canon = ['a', 'b', 'c'];
    const myOrder = canon.map(x => shown.indexOf(x));
    P[0].emit('player:submit_order', { order: myOrder }); await wait(300);
    d.emit('director:reveal_answer'); await wait(500);
    const lb = P[0].sync.lastQuestionScores[T[0]];
    check('Boom: orden propio comparable con la solución', lb.correct === true && JSON.stringify(lb.answer) === '[0,1,2]' /* orden real del contenido; el iPad lo recibe por pasos */, lb);
    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
