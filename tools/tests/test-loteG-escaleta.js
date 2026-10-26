// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteG-escaleta.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote G: (1) escaleta: el orden de rondas del backoffice llega solo al coordinador abierto, a la
// pantalla y a los iPads; (2) puntos por rapidez con milésimas: dos equipos que responden en el
// mismo segundo ya no empatan (mitad fija + mitad según la rapidez + extra al más rápido).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3212;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteG');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'Escaleta', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rA = await mk('Multi A', 'multirespuesta', { time: 30, points: 1000, fastestExtra: true }, [{ statement: 'M1', options: ['x', 'y'], correct: [1] }, { statement: 'M2', options: ['x', 'y'], correct: [0] }]);
    const rB = await mk('Pulsa B', 'pulsador', { time: 30, basePoints: 100, bonusMax: 300 }, [{ statement: 'P1', answer: 'x' }]);
    const rC = await mk('Multi C', 'multirespuesta', { time: 30, basePoints: 100, bonusMax: 50 }, [{ statement: 'M3', options: ['x', 'y'], correct: [1] }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    let roundsChanged = 0; d.on('game:rounds_changed', () => { roundsChanged++; });
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const P = [];
    for (let i = 0; i < 4; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'a' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'a' + i }); P.push(p);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);

    // ── 1. Escaleta
    const names = async () => (await api(`/games/${g.id}`)).data.rounds.map(r => r.name);
    check('Orden inicial = orden de creación', JSON.stringify(await names()) === JSON.stringify(['Multi A', 'Pulsa B', 'Multi C']), await names());
    roundsChanged = 0;
    await api(`/games/${g.id}/rounds/reorder`, { method: 'PUT', body: { order: [rC.id, rA.id, rB.id] } }); await wait(400);
    check('Al arrastrar en el backoffice, el coordinador abierto recibe el aviso', roundsChanged >= 1, roundsChanged);
    check('La lista que recarga el coordinador viene en el orden nuevo', JSON.stringify(await names()) === JSON.stringify(['Multi C', 'Multi A', 'Pulsa B']), await names());
    check('Pantalla e iPads (menús) reciben el orden nuevo sin reiniciar el servidor', JSON.stringify((P[0].sync.rounds || []).map(r => r.name)) === JSON.stringify(['Multi C', 'Multi A', 'Pulsa B']), (P[0].sync.rounds || []).map(r => r.name));
    roundsChanged = 0;
    await api(`/rounds/${rB.id}`, { method: 'PUT', body: { name: 'Pulsa B2' } }); await wait(300);
    check('Renombrar una ronda también avisa al coordinador', roundsChanged >= 1, roundsChanged);
    roundsChanged = 0;
    const other = (await api('/games', { method: 'POST', body: { name: 'Otro' } })).data;
    await api(`/games/${other.id}/rounds`, { method: 'POST', body: { name: 'X', type: 'pulsador', config: {} } }); await wait(300);
    check('Cambios en otro juego no molestan a este coordinador', roundsChanged === 0, roundsChanged);

    // ── 2. Rapidez con milésimas (1000 puntos: 500 fijos + 500 en 30 s = 16,7 por segundo; extra 100)
    const startQuestion = async (round, idx) => {
        d.emit('director:launch_round', { roundId: round.id }); await wait(200);
        d.emit('director:launch_question', { idx }); await wait(200);
        d.emit('director:reveal_options');
        // Cuenta atrás previa de 5 s; el reloj arranca después
        for (let i = 0; i < 80 && !(d.state.director.timer && d.state.director.timer.running); i++) await wait(100);
    };
    await startQuestion(rA, 0);
    await wait(150);
    for (let i = 0; i < 4; i++) { P[i].emit('player:submit_answer', { answer: [1] }); await wait(220); }
    await wait(300);
    d.emit('director:reveal_answer'); await wait(500);
    const sc = T.map(t => d.state.director.scores[t]);
    check('Cuatro aciertos en menos de un segundo: cuatro puntuaciones distintas', new Set(sc).size === 4, sc);
    check('…y el más rápido saca más', sc[0] > sc[1] && sc[1] > sc[2] && sc[2] > sc[3], sc);
    check('El más rápido se lleva el extra (100) y entre los demás ~3-4 puntos cada 0,22 s', sc[0] - sc[1] >= 100 && sc.slice(2).every((v, i) => { const dlt = sc[i + 1] - v; return dlt >= 2 && dlt <= 6; }), sc);
    check('Entre 500 (acertar) y 1100 (todo + extra)', sc.every(v => v <= 1100 && v >= 500), sc);

    // Mismo instante (dentro de unos pocos ms): empate legítimo, sin errores
    const before = T.map(t => d.state.director.scores[t] || 0);
    cmd('director:next_question'); await wait(200);
    d.emit('director:reveal_options');
    for (let i = 0; i < 80 && !(d.state.director.timer && d.state.director.timer.running); i++) await wait(100);
    await wait(100);
    P[0].emit('player:submit_answer', { answer: [0] }); P[1].emit('player:submit_answer', { answer: [1] });
    await wait(300); d.emit('director:reveal_answer'); await wait(500);
    const gain = T.map((t, i) => (d.state.director.scores[t] || 0) - before[i]);
    check('Fallo no suma; acierto sí (y el extra, al ser el único)', gain[0] >= 1000 && gain[1] === 0, gain);

    // ── 3. Pulsador: el bonus cuenta desde que pulsan, no desde que el coordinador marca el acierto
    await startQuestion(rB, 0);
    d.emit('director:open_buzzer'); await wait(200);
    const tRun = !!(d.state.director.timer && d.state.director.timer.running);
    P[2].emit('pulsar_boton'); await wait(1600);
    const s2 = d.state.director.scores[T[2]] || 0;
    cmd('director:mark_correct', { teamId: T[2] }); await wait(400);
    const won = (d.state.director.scores[T[2]] || 0) - s2;
    const remNow = d.state.director.timer.remaining, tot = d.state.director.timer.total;
    const bonusIfMarked = tot > 0 ? Math.floor(300 * remNow / tot) : 0;
    check('Pulsador: puntos enteros (ronda antigua base 100: el bonus no se usaba)', won === 100, { won, bonusIfMarked, timerCorriendo: tRun });

    // ── 4. Ronda antigua (base 100 + bonus 50 = 150): 75 fijos + 75 en 30 s → 0,4 s por punto
    await startQuestion(rC, 0);
    await wait(100);
    P[0].emit('player:submit_answer', { answer: [1] }); await wait(700);
    P[1].emit('player:submit_answer', { answer: [1] }); await wait(300);
    const b0 = T.map(t => d.state.director.scores[t] || 0);
    d.emit('director:reveal_answer'); await wait(500);
    const g2 = T.map((t, i) => (d.state.director.scores[t] || 0) - b0[i]);
    check('Ronda antigua convertida: 0,7 s de diferencia ya separa (y el primero lleva +15 de extra)', g2[0] - g2[1] >= 16 && g2[1] >= 75 && g2[0] <= 165, g2);

    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
