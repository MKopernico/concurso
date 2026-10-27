// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteI-agroland.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Arreglos de la prueba de AGROLAND (27/10): respuestas que llegan tarde a otra pregunta o antes de
// abrir las opciones, orden de Boom colocado sin «Enviar» y color secundario legible sobre oscuro.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3219;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteI');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'LoteI', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rMul = await mk('Multi', 'multirespuesta', { time: 30, points: 500 }, [
        { statement: 'P1', options: ['a', 'b', 'c', 'd'], correct: [0] },
        { statement: 'P2', options: ['a', 'b', 'c', 'd'], correct: [2] }]);
    const ITEMS = ['Uno', 'Dos', 'Tres', 'Cuatro'];
    const rBoom = await mk('Boom', 'boom', { time: 30, points: 500 }, [
        { statement: 'B1', items: ITEMS, correct_order: [0, 1, 2, 3] },
        { statement: 'B2', items: ITEMS, correct_order: [0, 1, 2, 3] }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const P = [];
    for (let i = 0; i < 3; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'i' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'i' + i }); P.push(p);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);
    const ans = () => d.state.director.answers || {};

    // ── Multirespuesta: nada cuenta antes de abrir las opciones
    d.emit('director:launch_round', { roundId: rMul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const key1 = P[0].sync.questionKey;
    P[0].emit('player:submit_answer', { answer: 0 }); await wait(200);
    check('Multirespuesta: una respuesta antes de «Abrir opciones» se descarta', !ans()[T[0]], ans()[T[0]]);
    d.emit('director:reveal_options'); await wait(300);
    P[0].emit('player:submit_answer', { answer: 0, k: key1 }); await wait(200);
    P[1].emit('player:submit_answer', { answer: 1 }); await wait(200); // iPad sin actualizar: sin «k»
    check('Multirespuesta: con la pregunta correcta en «k» se acepta', ans()[T[0]] && ans()[T[0]].answer === 0);
    check('Multirespuesta: un iPad sin actualizar (sin «k») sigue pudiendo responder', ans()[T[1]] && ans()[T[1]].answer === 1);

    // ── La respuesta de la P1 llega tarde, con la P2 ya en marcha
    d.emit('director:reveal_answer'); await wait(300);
    cmd('director:next_question'); await wait(300);
    const key2 = P[2].sync.questionKey;
    check('La pregunta 2 tiene otra clave', key2 && key2 !== key1, { key1, key2 });
    P[2].emit('player:submit_answer', { answer: 3, k: key1 }); await wait(200);
    check('Respuesta tardía de la P1 (antes de abrir la P2): se descarta', !ans()[T[2]], ans()[T[2]]);
    d.emit('director:reveal_options'); await wait(300);
    P[2].emit('player:submit_answer', { answer: 3, k: key1 }); await wait(200);
    check('Respuesta tardía de la P1 (con la P2 abierta): se descarta', !ans()[T[2]], ans()[T[2]]);
    P[2].emit('player:submit_answer', { answer: 2, k: key2 }); await wait(200);
    check('El equipo sigue pudiendo responder la P2', ans()[T[2]] && ans()[T[2]].answer === 2);

    // ── Boom: orden colocado entero sin «Enviar» cuenta al cerrar
    d.emit('director:launch_round', { roundId: rBoom.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const kb = P[0].sync.questionKey;
    P[0].emit('player:update_order', { order: [0, 1, 2, 3], k: kb }); await wait(200);
    check('Boom: un orden provisional antes de abrir las opciones se descarta', !ans()[T[0]]);
    d.emit('director:reveal_options'); await wait(400);
    const shown = P[0].sync.question.content.items;
    const good = ITEMS.map(x => shown.indexOf(x));
    P[0].emit('player:update_order', { order: good, k: kb }); await wait(150);           // todo colocado, sin enviar
    P[1].emit('player:update_order', { order: [good[0], null, good[2], good[3]], k: kb }); await wait(150); // a medias
    P[2].emit('player:update_order', { order: good, k: kb }); await wait(150);
    P[2].emit('player:submit_order', { order: good, k: kb }); await wait(200);            // y luego «Enviar»
    check('Boom: el orden provisional no cuenta como «ya ha respondido»', !(P[0].sync.answeredTeams || []).includes(T[0]) && (P[0].sync.answeredTeams || []).includes(T[2]), P[0].sync.answeredTeams);
    check('Boom: un orden a medias no se guarda', !ans()[T[1]], ans()[T[1]]);
    check('Boom: «Enviar» tras el provisional lo hace definitivo', ans()[T[2]] && ans()[T[2]].submitted === true);
    const before = { ...d.state.director.scores };
    d.emit('director:reveal_answer'); await wait(400);
    for (let i = 0; i < 4; i++) { cmd('director:reveal_next_pair'); await wait(250); }
    const sc = d.state.director.scores, gain = (t) => (sc[t] || 0) - (before[t] || 0);
    check('Boom: el orden colocado sin «Enviar» suma solo la parte fija (250)', gain(T[0]) === 250, gain(T[0]));
    check('Boom: el que envió suma más y se lleva el extra', gain(T[2]) > 500, { enviado: gain(T[2]), sinEnviar: gain(T[0]) });
    check('Boom: el que lo dejó a medias no suma', gain(T[1]) === 0, gain(T[1]));

    // ── Color secundario legible
    global.window = {}; global.document = { addEventListener() {} };
    require(path.join(REPO, 'public/shared/gameshow-transitions.js'));
    const f = window.GameShowShared.Theme.readableOnDark;
    const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
    const blue = f('#0822e2');
    check('Azul marino del juego: se aclara hasta leerse sobre oscuro (≥ 4,5:1)', (lum(blue) + 0.05) / (lum('#0a0a10') + 0.05) >= 4.5, blue);
    check('Colores ya legibles (naranja, amarillo, blanco): no cambian', f('#f08000') === '#f08000' && f('#facc15') === '#facc15' && f('#ffffff') === '#ffffff');
    check('Color no válido: se devuelve tal cual', f('rojo') === 'rojo');

    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    d.close(); P.forEach(p => p.close()); server.kill();
    process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); if (server) server.kill(); process.exit(1); });
