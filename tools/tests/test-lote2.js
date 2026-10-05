// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-lote2.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Pruebas del Lote 2 contra un servidor propio (puerto 3201, BD temporal).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3201;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-lote2');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex'); // el servidor de prueba arranca con esta contraseña
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

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
function director(gameId) {
    const s = io(B, { query: { gameId }, transports: ['websocket'], extraHeaders: { cookie } });
    s.on('game:director_sync', st => { s.state = st; });
    s.on('connect', () => s.emit('director:join'));
    s.cmd = (ev, data = {}) => s.emit(ev, { ...data, at: s.state.director.currentQuestionIdx, round: s.state.director.currentRoundId });
    return s;
}
function client(gameId, query = {}) {
    const s = io(B, { query: { gameId, ...query }, transports: ['websocket'], forceNew: true });
    s.events = []; s.sync = null;
    s.onAny((ev, d) => { s.events.push({ ev, d }); if (ev === 'game:player_sync') s.sync = d; });
    return s;
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));
const D = () => d.state.director;
let d;

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });

    const g = (await api('/games', { method: 'POST', body: { name: 'Test Lote2', status: 'published', access_code: '2468' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rMulti = await mk('Multi', 'multirespuesta', { time: 20, basePoints: 100, bonusMax: 0, penalty: 10 }, [{ statement: 'M1', options: ['a', 'b', 'c'], correct: [0, 2] }, { statement: 'M2', options: ['x', 'y'], correct: [1] }]);
    const rPul = await mk('Pulsa', 'pulsador', { basePoints: 100, bonusMax: 50, penalty: 0 }, [{ statement: 'P1', answer: 'x' }]);
    const rRul = await mk('Ruleta', 'ruleta', { basePoints: 100, bonusMax: 50 }, [{ phrase: 'LA CASA DE PAPEL', hint: 'serie' }]);
    const rBoom = await mk('Boom', 'boom', { time: 20, basePoints: 100, bonusMax: 0 }, [{ statement: 'Ordena', items: ['uno', 'dos', 'tres', 'cuatro'], correct_order: [0, 1, 2, 3] }]);
    const rId = await mk('Identidad', 'identidad', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: 'Empareja', pairs: [{ left: 'A', right: 'a' }, { left: 'B', right: 'b' }, { left: 'C', right: 'c' }] }]);
    const rImg = await mk('Imagen', 'imagen', { basePoints: 100 }, [{ image: '/uploads/images/secreta.png', answer: 'SECRETO', grid_rows: 2, grid_cols: 2 }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    d = director(g.id); await connected(d); await wait(400);
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '2468' } })).data.pass;
    const P = [];
    for (let i = 0; i < 2; i++) { const p = client(g.id, { pass, deviceId: 'd' + i }); await connected(p); p.emit('player:register_team', { name: 'E' + i, deviceId: 'd' + i }); P.push(p); }
    const scr = client(g.id); await connected(scr); scr.emit('screen:join');
    const anon = client(g.id); await connected(anon);
    await wait(600);
    const T = d.state.equipos.map(t => t.id);
    const score = (i) => D().scores[T[i]] || 0;

    // ── Accesos: conexión sin pase no escucha la sala
    d.emit('director:launch_round', { roundId: rMulti.id }); await wait(300);
    check('conexión sin código no recibe nada de la partida', !anon.events.some(e => e.ev === 'game:player_sync' || e.ev === 'game:timer_tick'), anon.events.map(e => e.ev));

    // ── Multirespuesta con dos correctas: vale cualquiera
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:reveal_options'); await wait(400);
    P[0].emit('player:submit_answer', { answer: 2 }); P[1].emit('player:submit_answer', { answer: 1 }); await wait(400);
    const s0 = score(0), s1 = score(1);
    d.emit('director:reveal_answer'); await wait(500);
    check('multirespuesta: elegir cualquiera de las correctas puntúa', score(0) - s0 === 100, score(0) - s0);
    check('multirespuesta: opción incorrecta penaliza', score(1) - s1 === -10, score(1) - s1);
    // ── "R" a destiempo no vuelve a puntuar
    const before = [score(0), score(1)];
    d.emit('director:reveal_answer'); await wait(300);
    check('revelar otra vez no vuelve a puntuar', score(0) === before[0] && score(1) === before[1]);
    // ── Siguiente y Anterior: la pregunta puntuada se ve revelada y no se vuelve a puntuar
    d.cmd('director:next_question'); await wait(400);
    d.cmd('director:prev_question'); await wait(400);
    check('Anterior a pregunta puntuada: se muestra revelada', D().phase === 'answer_revealed' && D().currentQuestionIdx === 0, { phase: D().phase });
    P[0].emit('player:submit_answer', { answer: 0 }); d.emit('director:reveal_answer'); await wait(400);
    check('…y no se puede volver a puntuar', score(0) === before[0], score(0));

    // ── Espera a mitad de pregunta y volver
    d.cmd('director:next_question'); await wait(300);
    d.emit('director:show_waiting'); await wait(300);
    check('Espera recuerda la pregunta', D().resumePhase === 'question', D().resumePhase);
    d.emit('director:resume_question'); await wait(300);
    check('Volver a la pregunta', D().phase === 'question' && D().currentQuestionIdx === 1, { phase: D().phase, idx: D().currentQuestionIdx });

    // ── Pulsador: Fallo sin rebote; tipos sin temporizador
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:start_timer'); await wait(300);
    check('▶/Espacio no arranca tiempo en pulsador', D().timer.running === false);
    d.emit('director:open_buzzer'); await wait(200);
    P[0].emit('pulsar_boton'); await wait(300);
    d.cmd('director:mark_wrong', { teamId: T[0] }); await wait(300);
    P[0].emit('pulsar_boton'); await wait(300);
    check('equipo con Fallo no puede volver a pulsar', !d.state.colaPulsador.some(p => p.id === T[0]), d.state.colaPulsador.map(p => p.id));
    check('el iPad sabe que falló', (P[0].sync.buzzerFailed || []).includes(T[0]));

    // ── Ruleta: acierto = solo puntos base; frase oculta en iPads, completa en pantalla
    d.emit('director:launch_round', { roundId: rRul.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:reveal_letter', { letter: 'A' }); await wait(400);
    const phraseP = P[1].sync.question.content.phrase, phraseS = scr.sync.question.content.phrase;
    check('ruleta: el iPad solo ve letras destapadas', phraseP === '•A •A•A •• •A•••', phraseP);
    check('ruleta: la pantalla recibe la frase completa', phraseS === 'LA CASA DE PAPEL', phraseS);
    d.emit('director:open_buzzer'); await wait(200);
    P[1].emit('pulsar_boton'); await wait(300);
    const sr = score(1);
    d.cmd('director:mark_correct', { teamId: T[1] }); await wait(300);
    check('ruleta: Acierto suma solo los puntos base', score(1) - sr === 100, score(1) - sr);

    // ── Imagen: el iPad no recibe la imagen ni la respuesta
    d.emit('director:launch_round', { roundId: rImg.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const ci = P[0].sync.question.content;
    check('imagen: el iPad no recibe la imagen ni la respuesta', !ci.image && !ci.answer, Object.keys(ci));
    check('imagen: la pantalla sí recibe la imagen', scr.sync.question.content.image === '/uploads/images/secreta.png');

    // ── Boom: elementos barajados para el iPad; su respuesta se traduce
    d.emit('director:launch_round', { roundId: rBoom.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(400);
    const shown = P[0].sync.question.content.items;
    check('boom: los elementos llegan barajados', JSON.stringify(shown) !== JSON.stringify(['uno', 'dos', 'tres', 'cuatro']) && shown.length === 4, shown);
    const correctInShown = ['uno', 'dos', 'tres', 'cuatro'].map(t => shown.indexOf(t));
    P[0].emit('player:submit_order', { order: correctInShown });
    P[1].emit('player:submit_order', { order: [0, 1, 2, 3] });
    await wait(300);
    const b0 = score(0), b1 = score(1);
    d.emit('director:reveal_answer'); await wait(400);
    check('boom: el orden correcto (en lo que ve el iPad) puntúa', score(0) - b0 === 100, score(0) - b0);
    check('boom: el orden "tal cual llega" no acierta', score(1) - b1 <= 0, score(1) - b1);

    // ── Identidad: etiquetas ya barajadas, sin orden canónico; respuesta traducida
    d.emit('director:launch_round', { roundId: rId.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await wait(400);
    const cId = P[0].sync.question.content;
    check('identidad: los índices que ve el iPad no son los reales', JSON.stringify(cId.rightShuffled) === '[0,1,2]' && JSON.stringify(cId.rightsCanonical) !== '["a","b","c"]', cId);
    const want = ['a', 'b', 'c'].map(t => cId.rightsCanonical.indexOf(t));
    P[0].emit('player:update_order', { order: want }); await wait(200);
    P[0].emit('player:submit_order', { order: want }); await wait(300);
    const i0 = score(0);
    d.emit('director:reveal_answer'); await wait(400);
    check('identidad: el emparejamiento correcto puntúa', score(0) - i0 === 100, score(0) - i0);
    check('identidad: el resultado guarda el orden real', JSON.stringify((P[0].sync.lastQuestionScores[T[0]] || {}).answer) === '[0,1,2]');

    // ── Reiniciar puntuaciones deja todo limpio
    d.emit('director:block_all'); await wait(200);
    d.emit('director:reset_session'); await wait(400);
    check('reiniciar puntuaciones: sin congelados ni puntos', d.state.equipos.every(t => !t.bloqueado && (!t.bonos || !t.bonos.length)) && Object.values(D().scores).every(v => v === 0), d.state.equipos);

    [d, scr, anon, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} pruebas superadas`);
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
