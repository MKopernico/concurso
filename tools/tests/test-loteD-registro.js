// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteD-registro.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote D: registro del coordinador. Puntos a mano, aciertos y fallos, preguntas puntuadas,
// bonos, congelaciones y reinicios quedan con hora; el registro no viaja entero en cada actualización.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3206;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteD');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'LoteD', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rPul = await mk('Pulsa', 'pulsador', { basePoints: 100, penalty: 20 }, [{ statement: 'P1', answer: 'x' }]);
    const rMul = await mk('Multi', 'multirespuesta', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: 'M', options: ['x', 'y'], correct: [1] }]);
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

    const getLog = () => new Promise(res => { d.once('director:log', res); d.emit('director:get_log'); });
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:open_buzzer'); await wait(200);
    P[0].emit('pulsar_boton'); await wait(80); P[1].emit('pulsar_boton'); await wait(300);
    cmd('director:mark_wrong', { teamId: T[0] }); await wait(200);
    cmd('director:mark_correct', { teamId: T[1] }); await wait(300);
    d.emit('director:add_points', { teamId: T[2], points: -30 }); await wait(150);
    d.emit('director:block_team', { teamId: T[2] }); await wait(150);
    d.emit('director:unblock_all'); await wait(150);
    d.emit('admin_gestionar_bono', { equipoId: T[0], accion: 'add', tipo: 'freeze' }); await wait(150);
    P[0].emit('usar_bono', { tipo: 'freeze', targetId: T[1] }); await wait(300);
    d.emit('director:launch_round', { roundId: rMul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(300);
    P[1].emit('player:submit_answer', { answer: [1] }); P[2].emit('player:submit_answer', { answer: [0] }); await wait(300);
    d.emit('director:reveal_answer'); await wait(400);
    let L = (await getLog()).log;
    const acts = L.map(e => e.action);
    const find = a => L.find(e => e.action === a);
    console.log('   acciones:', acts.join(', '));
    check('Registra la ronda lanzada', L.filter(e => e.action === 'round').length === 2);
    check('Registra el fallo con su penalización', find('wrong') && find('wrong').team === 'Equipo 0' && find('wrong').pts === -20, find('wrong'));
    check('Registra el acierto con sus puntos', find('correct') && find('correct').team === 'Equipo 1' && find('correct').pts === 100, find('correct'));
    check('Registra los puntos a mano', find('points') && find('points').pts === -30 && find('points').team === 'Equipo 2');
    check('Registra congelar y descongelar a todos', !!find('freeze') && !!find('unfreeze_all'));
    check('Registra el bono dado a mano', find('bono_add') && find('bono_add').bono === 'freeze');
    check('Registra el bono usado y contra quién', find('used') && find('used').team === 'Equipo 0' && find('used').target === 'Equipo 1', find('used'));
    check('Registra la pregunta puntuada sola (1 de 3 acertó)', find('scored') && find('scored').hits === 1 && find('scored').answered === 2 && find('scored').total === 3, find('scored'));
    check('Cada entrada lleva hora y, dentro de una ronda, en qué pregunta', L.every(e => typeof e.ts === 'number') && find('correct').ctx === 'Pulsa · P1', find('correct').ctx);
    check('El coordinador recibe solo el contador y las últimas entradas', d.state.director.logCount === L.length && d.state.director.bonoLog.length <= 5, { count: d.state.director.logCount, len: d.state.director.bonoLog.length });
    d.emit('director:reset_session'); await wait(400);
    L = (await getLog()).log;
    check('Reiniciar deja el registro con solo el reinicio', L.length === 1 && L[0].action === 'reset' && !L[0].ctx, L);
    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
