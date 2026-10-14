// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteA-ensayo.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Arreglos del ensayo (Lote A): «Acierto» cierra la pregunta, empate en Precio justo y
// «Descongelar a todos» tras un «congelar a todos» de un equipo.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3203;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteA');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'LoteA', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rPul = await mk('Pulsa', 'pulsador', { basePoints: 100 }, [{ statement: 'P1', answer: 'x' }, { statement: 'P2', answer: 'y' }]);
    const rPre = await mk('Precio', 'precio', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: '¿Cuánto?', correct_value: 50 }]);
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

    // ── «Acierto» cierra el pulsador, vacía la cola y revela
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:open_buzzer'); await wait(200);
    P[1].emit('pulsar_boton'); await wait(80); P[2].emit('pulsar_boton'); await wait(80); P[0].emit('pulsar_boton'); await wait(300);
    const first = d.state.colaPulsador[0].id;
    cmd('director:mark_correct', { teamId: first }); await wait(400);
    check('Acierto: la pregunta pasa a respuesta revelada', d.state.director.phase === 'answer_revealed', d.state.director.phase);
    check('Acierto: pulsador cerrado y cola vacía (nadie aparece como «primero»)', d.state.pulsadorActivo === false && d.state.colaPulsador.length === 0, { activo: d.state.pulsadorActivo, cola: d.state.colaPulsador.length });
    check('Acierto: los iPads saben qué equipo acertó', P[0].sync && P[0].sync.buzzerWinner === first);
    check('Acierto: suma los puntos una vez', d.state.director.scores[first] === 100, d.state.director.scores[first]);
    cmd('director:next_question'); await wait(300);
    check('«Siguiente» funciona tras el acierto', d.state.director.currentQuestionIdx === 1 && d.state.director.phase === 'question');

    // ── Precio justo: dos equipos clavan el precio
    d.emit('director:launch_round', { roundId: rPre.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(300);
    P[0].emit('player:submit_price', { value: 50 }); await wait(150);
    P[1].emit('player:submit_price', { value: 50 }); await wait(150);
    P[2].emit('player:submit_price', { value: 30 }); await wait(300);
    d.emit('director:reveal_answer'); await wait(500);
    const lqs = P[1].sync.lastQuestionScores;
    check('Precio: gana el primero en clavarlo', lqs[T[0]].correct === true);
    check('Precio: el segundo que lo clava ve que acertó pero el otro fue más rápido', lqs[T[1]].sameAsWinner === true && lqs[T[1]].exact === true && lqs[T[1]].winnerName === 'Equipo 0', lqs[T[1]]);
    check('Precio: quien no lo clava sigue viendo «te quedaste corto»', !lqs[T[2]].sameAsWinner && lqs[T[2]].passed === false);

    // ── «Congelar a todos» de un equipo y descongelar a todos
    d.emit('admin_gestionar_bono', { equipoId: T[0], accion: 'add', tipo: 'lock_all' }); await wait(200);
    P[0].emit('usar_bono', { tipo: 'lock_all' }); await wait(300);
    d.emit('director:join'); await wait(300);
    const frozen = d.state.equipos.filter(e => e.bloqueado).length;
    check('Congelar a todos (bono): los demás congelados, el que lo usa no', frozen === 2 && !d.state.equipos.find(e => e.id === T[0]).bloqueado, frozen);
    d.emit('director:unblock_all'); await wait(300); d.emit('director:join'); await wait(300);
    check('Descongelar a todos libera a todos', d.state.equipos.every(e => !e.bloqueado));

    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
