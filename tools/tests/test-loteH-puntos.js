// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteH-puntos.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote H: sistema de puntos. «Puntos» (500 por defecto) = lo máximo por acertar: la mitad fija y la
// otra mitad según la rapidez (con milésimas); +10 % al más rápido de los que aciertan («extra»).
// Precio: ganan todos los que dicen la mejor cifra (extra al más rápido). Identidad: la parte fija,
// proporcional. Pulsador y pruebas sin tiempo: puntos enteros. Juegos y Excel antiguos (puntos
// base + bonus) se convierten.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const XLSX = require(path.resolve(__dirname, '..', '..', 'node_modules', 'xlsx'));
const QV = require(path.resolve(__dirname, '..', '..', 'public', 'shared', 'question-validation.js'));

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3214;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteH');
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
const speed = (P, rem, total) => (P - Math.floor(P / 2)) + Math.floor(Math.floor(P / 2) * Math.min(1, Math.max(0, rem / total)));

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });

    // ── Funciones comunes (servidor y backoffice)
    check('Ronda sin puntos: 500 y extra activado', QV.roundPoints('multirespuesta', {}) === 500 && QV.fastestExtraOf({}, {}) === true);
    check('Ronda antigua multirespuesta 100 + 50 → 150', QV.roundPoints('multirespuesta', { basePoints: 100, bonusMax: 50 }) === 150);
    check('Ronda antigua de pulsador / aclara / abierta: solo los base (el bonus no se usaba allí)', QV.roundPoints('pulsador', { basePoints: 100, bonusMax: 50 }) === 100 && QV.roundPoints('aclara', { basePoints: 80, bonusMax: 50 }) === 80 && QV.roundPoints('abierta', { basePoints: 90, bonusMax: 30 }) === 90);
    check('Pictionary antiguo: con tiempo suma el bonus, sin tiempo no', QV.roundPoints('pictionary', { time: 60, basePoints: 100, bonusMax: 50 }) === 150 && QV.roundPoints('pictionary', { time: 0, basePoints: 100, bonusMax: 50 }) === 100);
    check('Pregunta antigua con solo «puntos base» 200 en ronda 100 + 50 → 250', QV.questionPoints('boom', { basePoints: 200 }, { basePoints: 100, bonusMax: 50 }) === 250);
    check('Pregunta sin puntos propios: hereda los de la ronda', QV.questionPoints('boom', {}, { points: 700 }) === 700);
    check('Extra: la pregunta manda sobre la ronda', QV.fastestExtraOf({ fastestExtra: false }, { fastestExtra: true }) === false && QV.fastestExtraOf({}, { fastestExtra: false }) === false);
    check('Reparto: al instante 500, a mitad 375, al final 250 (de 500)', QV.speedPoints(500, 30, 30) === 500 && QV.speedPoints(500, 15, 30) === 375 && QV.speedPoints(500, 0, 30) === 250);
    check('Extra = 10 % (500 → 50)', QV.extraPoints(500) === 50);

    // ── Partida
    const g = (await api('/games', { method: 'POST', body: { name: 'Puntos', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const q of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: q.content ? q : { content: q } }); return r; };
    const rMul = await mk('Multi', 'multirespuesta', { time: 20 }, [
        { statement: 'M1', options: ['x', 'y'], correct: [1] },
        { content: { statement: 'M2', options: ['x', 'y'], correct: [0] }, config: { fastestExtra: false } },
        { statement: 'M3', options: ['x', 'y'], correct: [0] }]);
    const rPre = await mk('Precio', 'precio', { time: 20 }, [{ statement: '¿Cuánto?', correct_value: 50 }]);
    const rId = await mk('Identidad', 'identidad', { time: 30 }, [{ statement: 'Une', pairs: [0, 1, 2, 3].map(i => ({ left: { text: 'L' + i }, right: { text: 'R' + i } })) }]);
    const rPul = await mk('Pulsa', 'pulsador', { penalty: 40 }, [{ statement: 'P1', answer: 'x' }]);
    const rOld = await mk('Antigua', 'multirespuesta', { time: 20, basePoints: 100, bonusMax: 50 }, [{ statement: 'V', options: ['x', 'y'], correct: [1] }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const P = [];
    for (let i = 0; i < 4; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'h' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'h' + i }); P.push(p);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);
    const ds = () => d.state.director;
    const scores = () => T.map(t => ds().scores[t] || 0);
    const untilRunning = async () => { for (let i = 0; i < 80 && !(ds().timer && ds().timer.running); i++) await wait(100); };
    const open = async (round, idx) => {
        if (ds().currentRoundId !== round.id) { d.emit('director:launch_round', { roundId: round.id }); await wait(250); }
        d.emit('director:launch_question', { idx }); await wait(250);
        d.emit('director:reveal_options'); await untilRunning();
    };

    // 1. Multirespuesta con 500 por defecto: fórmula exacta y extra al más rápido
    await open(rMul, 0); await wait(200);
    for (let i = 0; i < 4; i++) { P[i].emit('player:submit_answer', { answer: i === 3 ? [0] : [1] }); await wait(400); }
    await wait(200);
    const rems = T.map(t => ds().answers[t].timerRemaining);
    let s0 = scores();
    d.emit('director:reveal_answer'); await wait(500);
    let gain = scores().map((v, i) => v - s0[i]);
    const exp1 = [speed(500, rems[0], 20) + 50, speed(500, rems[1], 20), speed(500, rems[2], 20), 0];
    check('Multirespuesta: mitad fija + rapidez exacta y +50 al más rápido; el fallo no suma', JSON.stringify(gain) === JSON.stringify(exp1), { gain, exp1 });
    const lq = P[0].sync.lastQuestionScores;
    check('El iPad del más rápido sabe que se lleva el extra', lq[T[0]].extra === 50 && !lq[T[1]].extra && lq[T[0]].points === exp1[0], lq[T[0]]);

    // 2. Pregunta con el extra desactivado
    cmd('director:next_question'); await wait(250);
    d.emit('director:reveal_options'); await untilRunning(); await wait(100);
    P[2].emit('player:submit_answer', { answer: [0] }); await wait(300);
    s0 = scores(); d.emit('director:reveal_answer'); await wait(500);
    gain = scores().map((v, i) => v - s0[i]);
    check('Pregunta sin extra: el único acierto no lleva +50', gain[2] >= 250 && gain[2] <= 500 && !P[2].sync.lastQuestionScores[T[2]].extra, gain);

    // 3. Precio: dos clavan la cifra, uno se queda corto, otro se pasa
    await open(rPre, 0);
    P[1].emit('player:submit_price', { value: 50 }); await wait(150);
    P[3].emit('player:submit_price', { value: 50 }); await wait(150);
    P[0].emit('player:submit_price', { value: 40 }); await wait(100);
    P[2].emit('player:submit_price', { value: 60 }); await wait(250);
    s0 = scores(); d.emit('director:reveal_answer'); await wait(500);
    gain = scores().map((v, i) => v - s0[i]);
    check('Precio: los dos que la clavan, 500 cada uno; el primero +50; los demás 0', JSON.stringify(gain) === JSON.stringify([0, 550, 0, 500]), gain);
    check('Precio: la sala ve a los dos ganadores', (P[0].sync.precioWinners || []).map(w => w.teamId).sort().join() === [T[1], T[3]].sort().join() && P[0].sync.precioWinner.teamId === T[1]);

    // 4. Identidad: parcial proporcional a la parte fija; completa con rapidez + extra
    await open(rId, 0); await wait(100);
    // El iPad ve las respuestas barajadas: índice que tiene la respuesta correcta de cada pareja
    const cId = P[0].sync.question.content;
    const kOf = i => cId.rightsCanonical.findIndex(r => r.text === 'R' + i);
    const good = [0, 1, 2, 3].map(kOf);
    const half = [kOf(0), kOf(1), kOf(3), kOf(2)];
    P[1].emit('player:submit_order', { order: good }); await wait(300);
    P[2].emit('player:submit_order', { order: half }); await wait(300);
    const remId = ds().answers[T[1]].timerRemaining;
    s0 = scores();
    d.emit('director:reveal_answer'); await wait(500);
    for (let i = 0; i < 6; i++) { d.emit('director:reveal_next_pair'); await wait(200); }
    await wait(300);
    gain = scores().map((v, i) => v - s0[i]);
    check('Identidad: 4 de 4 = rapidez + extra; 2 de 4 = la mitad de los 250 fijos (125)', gain[1] === speed(500, remId, 30) + 50 && gain[2] === 125, { gain, esperado1: speed(500, remId, 30) + 50 });

    // 5. Pulsador: puntos enteros; fallo con penalización
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(250);
    d.emit('director:launch_question', { idx: 0 }); await wait(250);
    d.emit('director:open_buzzer'); await wait(200);
    P[0].emit('pulsar_boton'); await wait(80); P[1].emit('pulsar_boton'); await wait(300);
    s0 = scores();
    cmd('director:mark_wrong', { teamId: T[0] }); await wait(250);
    cmd('director:mark_correct', { teamId: T[1] }); await wait(400);
    gain = scores().map((v, i) => v - s0[i]);
    check('Pulsador: acierto = 500 enteros; fallo = −40', gain[1] === 500 && gain[0] === -40, gain);

    // 6. Ronda antigua (100 + 50): 150 en total, 75 fijos + rapidez, extra 15
    await open(rOld, 0); await wait(100);
    P[0].emit('player:submit_answer', { answer: [1] }); await wait(300);
    const remOld = ds().answers[T[0]].timerRemaining;
    s0 = scores(); d.emit('director:reveal_answer'); await wait(500);
    gain = scores().map((v, i) => v - s0[i]);
    check('Ronda antigua base 100 + bonus 50: se juega como 150 (75 fijos + rapidez + 15 de extra)', gain[0] === speed(150, remOld, 20) + 15, { gain: gain[0], esperado: speed(150, remOld, 20) + 15 });

    // ── Backoffice: la ronda guarda los campos nuevos
    const rNew = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Nueva', type: 'boom', config: { time: 30, points: 700, fastestExtra: false, penalty: 0 } } })).data;
    check('Ronda nueva guarda «points» y «fastestExtra»', rNew.config.points === 700 && rNew.config.fastestExtra === false);

    // ── Excel
    const exp = Buffer.from(await (await fetch(B + `/api/games/${g.id}/export-excel`, { headers: { cookie } })).arrayBuffer());
    const wbE = XLSX.read(exp);
    const rondas = XLSX.utils.sheet_to_json(wbE.Sheets['Rondas'], { header: 1, defval: '' });
    check('Exportar: hoja Rondas con columnas «puntos» y «extra_mas_rapido»', rondas[2][3] === 'puntos' && rondas[2][4] === 'extra_mas_rapido', rondas[2]);
    const rowNew = rondas.find(r => r[0] === 'Nueva'), rowOld = rondas.find(r => r[0] === 'Antigua');
    check('Exportar: la ronda nueva sale con 700 / no y la antigua convertida a 150 / si', rowNew && rowNew[3] === 700 && rowNew[4] === 'no' && rowOld && rowOld[3] === 150 && rowOld[4] === 'si', { rowNew, rowOld });
    const mulSheet = XLSX.utils.sheet_to_json(wbE.Sheets['Multirespuesta'], { header: 1, defval: '' });
    check('Exportar: la pregunta con el extra desactivado lo conserva («no»)', mulSheet.some(r => r[1] === 'M2' && r[11] === 'no') && mulSheet[2][10] === 'puntos', mulSheet.find(r => r[1] === 'M2'));
    const g2 = (await api('/games', { method: 'POST', body: { name: 'Reimport' } })).data;
    const fx = new FormData(); fx.append('file', new Blob([exp]), 'p.xlsx');
    await fetch(B + `/api/games/${g2.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } });
    const t2 = (await api(`/games/${g2.id}`)).data;
    const rN2 = t2.rounds.find(r => r.name === 'Nueva'), rO2 = t2.rounds.find(r => r.name === 'Antigua'), rM2 = t2.rounds.find(r => r.name === 'Multi');
    check('Ida y vuelta por Excel: mismos puntos y extra', rN2 && rN2.config.points === 700 && rN2.config.fastestExtra === false && rO2 && QV.roundPoints('multirespuesta', rO2.config) === 150
        && rM2 && rM2.questions.find(q => q.content.statement === 'M2').config.fastestExtra === false, { nueva: rN2 && rN2.config, antigua: rO2 && rO2.config });
    // Excel antiguo (cabeceras puntos_base / bonus_max)
    const wbL = XLSX.utils.book_new();
    const sheet = (head, rows) => XLSX.utils.aoa_to_sheet([['t'], [], head, ...rows]);
    XLSX.utils.book_append_sheet(wbL, sheet(['nombre', 'tipo', 'tiempo', 'puntos_base', 'bonus_max', 'penalizacion', 'logo', 'fondo'], [['Vieja', 'Boom', 20, 100, 50, 0]]), 'Rondas');
    XLSX.utils.book_append_sheet(wbL, sheet(['ronda', 'enunciado', 'elemento_1', 'elemento_2', 'elemento_3', 'elemento_4', 'elemento_5', 'orden_correcto', 'tiempo', 'puntos_base', 'bonus_max'],
        [['Vieja', 'Ordena', 'a', 'b', 'c', '', '', '', '', 200, 30]]), 'Boom');
    const g3 = (await api('/games', { method: 'POST', body: { name: 'Legacy' } })).data;
    const fl = new FormData(); fl.append('file', new Blob([XLSX.write(wbL, { type: 'buffer', bookType: 'xlsx' })]), 'v.xlsx');
    await fetch(B + `/api/games/${g3.id}/import-excel`, { method: 'POST', body: fl, headers: { cookie } });
    const t3 = (await api(`/games/${g3.id}`)).data;
    const rv = t3.rounds[0], qv = rv && rv.questions[0];
    check('Excel antiguo: ronda 100 + 50 = 150 y pregunta 200 + 30 = 230', rv && QV.roundPoints('boom', rv.config) === 150 && qv && QV.questionPoints('boom', qv.config, rv.config) === 230, { r: rv && rv.config, q: qv && qv.config });
    // Plantilla con ejemplos
    const tpl = Buffer.from(await (await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } })).arrayBuffer());
    const g4 = (await api('/games', { method: 'POST', body: { name: 'Ejemplos' } })).data;
    const ft = new FormData(); ft.append('file', new Blob([tpl]), 'e.xlsx');
    const impT = await (await fetch(B + `/api/games/${g4.id}/import-excel`, { method: 'POST', body: ft, headers: { cookie } })).json();
    const t4 = (await api(`/games/${g4.id}`)).data;
    check('Plantilla con ejemplos: se importa sin errores y con 500 puntos', !impT.errors.length && t4.rounds.length >= 10 && t4.rounds.every(r => QV.roundPoints(r.type, r.config) === 500), { errores: impT.errors, puntos: t4.rounds.map(r => QV.roundPoints(r.type, r.config)) });

    // ── «🎯 Puntos» del backoffice: todo el juego (o todos los juegos) a la vez
    const gp = (await api('/games', { method: 'POST', body: { name: 'Pasar a 500' } })).data;
    const rp1 = (await api(`/games/${gp.id}/rounds`, { method: 'POST', body: { name: 'A', type: 'multirespuesta', config: { time: 20, basePoints: 100, bonusMax: 50, penalty: 10, logo: '/l.png' } } })).data;
    const qp1 = (await api(`/rounds/${rp1.id}/questions`, { method: 'POST', body: { content: { statement: 'x', options: ['a', 'b'], correct: [0] }, config: { basePoints: 300, time: 15, premio: { tipo: 'freeze' } } } })).data;
    const before = { other: (await api(`/games/${g3.id}`)).data.rounds[0].config };
    const pr = await api(`/games/${gp.id}/points`, { method: 'PUT', body: { points: 500, fastestExtra: true } });
    const tp = (await api(`/games/${gp.id}`)).data;
    const rc1 = tp.rounds[0].config, qc1 = tp.rounds[0].questions[0].config;
    check('Puntos de todo el juego: la ronda pasa a 500 + extra y conserva tiempo, penalización y logo', pr.status === 200 && rc1.points === 500 && rc1.fastestExtra === true && rc1.basePoints === undefined && rc1.bonusMax === undefined && rc1.time === 20 && rc1.penalty === 10 && rc1.logo === '/l.png', rc1);
    check('…y la pregunta deja sus puntos propios (hereda) pero conserva tiempo y premio', qc1 && qc1.basePoints === undefined && qc1.points === undefined && qc1.time === 15 && qc1.premio && qc1.premio.tipo === 'freeze' && QV.questionPoints('multirespuesta', qc1, rc1) === 500, qc1);
    check('Solo ese juego: los demás no cambian', JSON.stringify((await api(`/games/${g3.id}`)).data.rounds[0].config) === JSON.stringify(before.other));
    const pa = await api(`/games/${gp.id}/points`, { method: 'PUT', body: { points: 400, fastestExtra: false, allGames: true } });
    const allTrees = await Promise.all((await api('/games')).data.map(x => api(`/games/${x.id}`)));
    const allRounds = allTrees.flatMap(t => t.data.rounds || []);
    check('Con «todos los juegos»: todas las rondas de todos los juegos a 400 sin extra', pa.status === 200 && pa.data.games >= 5 && allRounds.length > 0 && allRounds.every(r => r.config.points === 400 && r.config.fastestExtra === false), { juegos: pa.data, rondas: allRounds.length });
    check('Puntos no válidos se rechazan', (await api(`/games/${gp.id}/points`, { method: 'PUT', body: { points: -5 } })).status === 400);

    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
