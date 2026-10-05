// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-lote1.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Pruebas del Lote 1 contra un servidor propio (puerto 3200, BD temporal).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3200;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-lote1');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex'); // el servidor de prueba arranca con esta contraseña

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push({ name, ok: !!ok, info }); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    server.stdout.on('data', d => { const s = String(d); if (/\[socket|uncaught|unhandled/.test(s)) process.stdout.write('[srv] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}
async function stopServer() { server.kill(); await new Promise(r => server.once('exit', r)); }

async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await res.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: res.status, data };
}

function director(gameId) {
    const s = io(B, { query: { gameId }, transports: ['websocket'], extraHeaders: { cookie } });
    s.state = null;
    s.on('game:director_sync', st => { s.state = st; });
    s.on('connect', () => s.emit('director:join'));
    s.cmd = (ev, data = {}) => s.emit(ev, { ...data, at: s.state.director.currentQuestionIdx, round: s.state.director.currentRoundId });
    return s;
}
function player(gameId, pass, deviceId) {
    const s = io(B, { query: { gameId, deviceId, pass }, transports: ['websocket'], forceNew: true });
    s.events = [];
    s.onAny((ev, d) => s.events.push({ ev, d }));
    return s;
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    check('login', (await api('/auth/login', { method: 'POST', body: { password: PW } })).status === 200);

    // Juego: multirespuesta (3 preguntas, 10 s) + pulsador (2 preguntas)
    const g = (await api('/games', { method: 'POST', body: { name: 'Test Lote1', status: 'published' } })).data;
    const rm = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Multi', type: 'multirespuesta', config: { time: 10, basePoints: 100, bonusMax: 50, penalty: 0 } } })).data;
    for (let i = 0; i < 3; i++) await api(`/rounds/${rm.id}/questions`, { method: 'POST', body: { content: { statement: 'P' + i, options: ['a', 'b', 'c'], correct: [0] } } });
    const rp = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Pulsa', type: 'pulsador', config: { basePoints: 100, bonusMax: 0 } } })).data;
    for (let i = 0; i < 2; i++) await api(`/rounds/${rp.id}/questions`, { method: 'POST', body: { content: { statement: 'Q' + i, answer: 'x' } } });
    check('sesión creada', (await api(`/games/${g.id}/session`, { method: 'POST', body: {} })).status === 201);

    const d = director(g.id); await connected(d); await wait(400);
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const players = [];
    for (let i = 0; i < 3; i++) {
        const p = player(g.id, pass, 'dev' + i); await connected(p);
        p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'dev' + i, photo_url: i === 0 ? 'javascript:alert(1)' : '/uploads/images/ok.png' });
        players.push(p);
    }
    await wait(600);
    const teams = d.state.equipos;
    check('3 equipos registrados', teams.length === 3, teams.length);

    // ── Seguridad: deviceId/socketId no viajan; photo_url saneada
    const login = players[1].events.find(e => e.ev === 'login_success');
    const leaked = JSON.stringify(players.flatMap(p => p.events.filter(e => e.ev === 'actualizar_admin_equipos' || e.ev === 'login_success').map(e => e.d)));
    check('deviceId/socketId no se envían a los iPads', !/deviceId|socketId|dev0|dev1|dev2/.test(leaked));
    check('photo_url "javascript:" descartada', teams.find(t => t.nombre === 'Equipo 0').photo_url === null, teams.find(t => t.nombre === 'Equipo 0').photo_url);
    check('photo_url válida se conserva', teams.find(t => t.nombre === 'Equipo 1').photo_url === '/uploads/images/ok.png');
    check('login_success sin estado del coordinador', login && !('estado' in login.d));

    // ── Punto 1: doble "Abrir opciones" no deja temporizador huérfano
    d.emit('director:launch_round', { roundId: rm.id }); await wait(300);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:reveal_options'); d.emit('director:reveal_options'); d.emit('director:reveal_options');
    await wait(6500);
    check('el temporizador arranca tras la cuenta atrás', d.state.director.timer.running === true, d.state.director.timer);
    d.emit('director:stop_timer'); await wait(2500);
    check('"Parar tiempo" lo deja parado (sin intervalo huérfano)', d.state.director.timer.running === false, d.state.director.timer);
    // ── Punto 5: doble "Siguiente" avanza una sola pregunta
    d.cmd('director:next_question'); d.cmd('director:next_question'); await wait(500);
    check('doble "Siguiente" avanza solo una pregunta', d.state.director.currentQuestionIdx === 1, d.state.director.currentQuestionIdx);
    await wait(2500);
    check('la pregunta siguiente no arranca el tiempo sola', d.state.director.timer.running === false && d.state.director.phase === 'question', { t: d.state.director.timer, phase: d.state.director.phase });

    // ── Punto 5/7: pulsador — acierto una sola vez; congelar a todos y descongelar uno a uno
    d.emit('director:launch_round', { roundId: rp.id }); await wait(300);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:open_buzzer'); await wait(300);
    players[1].emit('pulsar_boton'); await wait(400);
    const t1 = teams.find(t => t.nombre === 'Equipo 1').id;
    const before = d.state.director.scores[t1] || 0;
    d.cmd('director:mark_correct', { teamId: t1 }); d.cmd('director:mark_correct', { teamId: t1 }); await wait(500);
    check('"Acierto" con doble toque suma una sola vez', (d.state.director.scores[t1] || 0) - before === 100, (d.state.director.scores[t1] || 0) - before);

    d.emit('director:block_all'); await wait(300);
    for (const t of d.state.equipos) d.emit('director:unblock_team', { teamId: t.id });
    await wait(300);
    d.emit('director:close_buzzer'); d.emit('director:reset_buzzer'); await wait(200);
    d.emit('director:open_buzzer'); await wait(300);
    players[2].emit('pulsar_boton'); await wait(400);
    check('tras congelar a todos y descongelar uno a uno, el pulsador funciona', d.state.colaPulsador.some(p => p.nombre === 'Equipo 2'), d.state.colaPulsador.map(p => p.nombre));

    // ── Punto 2a: datos mal formados no tumban el servidor
    players[0].emit('usar_bono', null); players[0].emit('player:submit_answer', null); players[0].emit('player:submit_price'); players[0].emit('pulsar_boton', { x: 1 });
    d.emit('director:add_points', null); d.emit('director:launch_question', null); d.emit('director:karaoke_award', null);
    await wait(500);
    check('eventos mal formados no tumban el servidor', (await fetch(B + '/ping')).ok);

    // ── Punto 4: reconexión del mismo iPad con la conexión vieja aún "viva"
    const p0id = teams.find(t => t.nombre === 'Equipo 0').id;
    const old = players[0];
    let oldKicked = false; old.on('disconnect', () => { oldKicked = true; });
    const neu = player(g.id, pass, 'dev0'); await connected(neu);
    neu.emit('player:reconnect', { deviceId: 'dev0' }); await wait(600);
    const okEv = neu.events.find(e => e.ev === 'login_success');
    check('reconexión del mismo iPad recupera su equipo (sin slot_taken)', okEv && okEv.d.miEquipo.id === p0id, neu.events.map(e => e.ev).filter(e => /login|reconnect_failed/.test(e)));
    check('la conexión vieja se cierra', oldKicked);
    players[0] = neu;

    // ── Seguridad: subida de imágenes
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    async function upload(headers, name, type) {
        const fd = new FormData(); fd.append('file', new Blob([png], { type }), name);
        const r = await fetch(B + '/api/upload/image', { method: 'POST', body: fd, headers });
        return { status: r.status, data: await r.json().catch(() => ({})) };
    }
    check('subida sin pase rechazada', (await upload({}, 'a.png', 'image/png')).status === 403);
    const up = await upload({ 'X-Game': g.id, 'X-Game-Pass': pass }, 'evil.html', 'image/png');
    check('subida con pase: extensión según el tipo (.html → .png)', up.status === 200 && /\.png$/.test(up.data.url), up);
    check('SVG desde iPad rechazado', (await upload({ 'X-Game': g.id, 'X-Game-Pass': pass }, 'x.svg', 'image/svg+xml')).status !== 200);
    const upStaff = await fetch(B + '/api/upload/image', { method: 'POST', body: (() => { const f = new FormData(); f.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'logo.svg'); return f; })(), headers: { cookie } });
    check('SVG desde el backoffice sí se admite', upStaff.status === 200);

    // ── Punto 3: "Jugar" con partida en marcha la reutiliza
    const again = await api(`/games/${g.id}/session`, { method: 'POST', body: {} });
    check('"Jugar" con partida en marcha la reutiliza', again.status === 200 && again.data.resumed === true, again.data);
    await wait(300);
    check('los equipos siguen tras reabrir', d.state.equipos.length === 3, d.state.equipos.length);

    // ── Punto 2b: el marcador sobrevive a un reinicio
    d.emit('director:add_points', { teamId: t1, points: 250 }); await wait(300);
    const expected = { ...d.state.director.scores };
    await wait(2600); // guardado periódico (2 s)
    d.close(); players.forEach(p => p.close());
    await stopServer();
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const d2 = director(g.id); await connected(d2); await wait(600);
    const restored = d2.state.director.scores;
    check('tras reiniciar el servidor, los puntos se conservan', Object.keys(expected).every(k => restored[k] === expected[k]), { expected, restored });

    // ── Punto 3b: partida nueva explícita reinicia y avisa a los iPads
    const p9 = player(g.id, pass, 'dev1'); await connected(p9); p9.emit('player:reconnect', { deviceId: 'dev1' }); await wait(500);
    const nueva = await api(`/games/${g.id}/session`, { method: 'POST', body: { nueva: true } });
    await wait(600);
    check('partida nueva explícita: 201', nueva.status === 201);
    check('partida nueva: los iPads reciben reset', p9.events.some(e => e.ev === 'game:reset_full'));
    check('partida nueva: marcador y equipos a cero en el coordinador', d2.state.equipos.length === 0 && Object.keys(d2.state.director.scores).length === 0, { eq: d2.state.equipos.length });

    d2.close(); p9.close();
    await stopServer();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} pruebas superadas`);
    process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
