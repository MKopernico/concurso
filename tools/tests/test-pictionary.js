// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-pictionary.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Pictionary: turnos (rueda al azar sin repetir, cambio a mano, modo «lo elige el coordinador"),
// la palabra solo a quien dibuja, trazos en directo a pantalla y coordinador (secuencia, deshacer,
// borrar, datos malos), quien dibuja no pulsa, el tiempo se para al pulsar y sigue tras un fallo,
// puntos para el que dibuja, fin del tiempo, volver a la pregunta con su dibujo, pizarra fija por QR,
// rueda guardada al reiniciar el servidor y Excel.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3213;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-pictionary');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined && !ok ? '  → ' + JSON.stringify(info) : '')); }

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
const once = (s, ev, ms = 1500) => new Promise(r => { const t = setTimeout(() => r(null), ms); s.once(ev, d => { clearTimeout(t); r(d === undefined ? true : d); }); });

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Pictionary', status: 'published', access_code: '1234' } })).data;
    const mk = async (name, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type: 'pictionary', config } })).data; for (const q of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: q }); return r; };
    const rEq = await mk('Equipos', { time: 30, basePoints: 100, bonusMax: 50, picMode: 'equipos', picTurns: 'auto', picDrawerPoints: 50 },
        [{ content: { word: 'Torre Eiffel', category: 'Monumentos' } }, { content: { word: 'Paraguas' } }, { content: { word: 'Bicicleta' } }, { content: { word: 'Reloj' }, config: { time: 2 } }]);
    const rMan = await mk('A mano', { time: 0, basePoints: 80, bonusMax: 50, picMode: 'equipos', picTurns: 'manual', picDrawerPoints: 0 }, [{ content: { word: 'Gato' } }]);
    const rPad = await mk('Pizarra', { time: 30, basePoints: 100, bonusMax: 0, picMode: 'ipad', picDrawerPoints: 40 }, [{ content: { word: 'Avión' } }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    d.chunks = []; d.on('pic:chunk', c => d.chunks.push(c));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '1234' } })).data.pass;
    const scr = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true });
    scr.on('game:player_sync', s => { scr.sync = s; });
    scr.chunks = []; scr.ops = []; scr.on('pic:chunk', c => scr.chunks.push(c)); scr.on('pic:op', o => scr.ops.push(o));
    await connected(scr); scr.emit('screen:join'); await wait(200);
    const P = [];
    for (let i = 0; i < 4; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'pic' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        p.words = []; p.on('pic:word', w => p.words.push(w));
        p.chunks = 0; p.on('pic:chunk', () => p.chunks++);
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'pic' + i }); P.push(p);
    }
    await wait(700);
    const T = d.state.equipos.map(e => e.id);
    const byTeam = (id) => P[T.indexOf(id)];
    const ds = () => d.state.director;

    // ── Pregunta 1: turno automático ──
    d.emit('director:launch_round', { roundId: rEq.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(350);
    const pic0 = ds().pictionary;
    check('Turno automático: propone un equipo y empieza sin la palabra', pic0 && pic0.step === 'setup' && T.includes(pic0.drawer), pic0);
    check('La palabra no llega ni a los iPads ni a la pantalla (sí la categoría)', !P[0].sync.question.content.word && !scr.sync.question.content.word && scr.sync.question.content.category === 'Monumentos', scr.sync.question.content);
    check('Todos saben quién dibuja', P[1].sync.pictionary.drawer === pic0.drawer && P[1].sync.pictionary.drawerName && scr.sync.pictionary.step === 'setup');
    const drawer0 = pic0.drawer, dp0 = byTeam(drawer0);
    const others0 = P.filter(p => p !== dp0);
    // Antes de empezar no se dibuja
    dp0.emit('pic:stroke', { k: P[0].sync.questionKey, s: 1, n: true, c: 0, w: 1, p: [100, 100, 200, 200] }); await wait(200);
    check('Antes de «Empezar» no se puede dibujar', scr.chunks.length === 0);
    // Cambiar a mano antes de empezar
    const alt = T.find(t => t !== drawer0);
    cmd('director:pic_set_drawer', { teamId: alt }); await wait(200);
    check('El coordinador puede cambiar quién dibuja', ds().pictionary.drawer === alt);
    cmd('director:pic_set_drawer', { teamId: drawer0 }); await wait(200);

    cmd('director:pic_start'); await wait(400);
    check('«Empezar a dibujar»: pulsador abierto y tiempo en marcha', ds().pictionary.step === 'drawing' && d.state.pulsadorActivo && ds().timer.running && ds().timer.total === 30, ds().timer);
    check('La palabra llega solo al equipo que dibuja', dp0.words.length === 1 && dp0.words[0].word === 'Torre Eiffel' && dp0.words[0].k === dp0.sync.questionKey && others0.every(p => p.words.length === 0), dp0.words);
    check('Queda apuntado en la rueda de turnos', (ds().picDone || []).includes(drawer0));

    // Trazos
    const key = dp0.sync.questionKey;
    dp0.emit('pic:stroke', { k: key, s: 1, n: true, c: 1, w: 1, p: [1000, 1000, 1200, 1300] });
    dp0.emit('pic:stroke', { k: key, s: 1, n: false, c: 1, w: 1, p: [1500, 1600] });
    dp0.emit('pic:stroke', { k: key, s: 2, n: true, c: 9, w: 2, p: [5000, 5000] });
    await wait(300);
    check('Los trazos llegan en directo a la pantalla, en orden', scr.chunks.length === 3 && scr.chunks.map(c => c.q).join(',') === '1,2,3' && scr.chunks[0].n === true && scr.chunks[1].n === false && scr.chunks[2].c === 9, scr.chunks);
    check('…y al coordinador (vista previa), pero no a los iPads', d.chunks.length === 3 && P.every(p => p.chunks === 0));
    others0[0].emit('pic:stroke', { k: key, s: 7, n: true, c: 0, w: 0, p: [10, 10] }); await wait(150);
    check('Otro equipo no puede dibujar', scr.chunks.length === 3);
    dp0.emit('pic:stroke', { k: key, s: 3, n: true, c: 0, w: 0, p: [10, 99999] });
    dp0.emit('pic:stroke', { k: key, s: 3, n: true, c: 0, w: 0, p: [10] });
    dp0.emit('pic:stroke', { k: key, s: 3, n: true, c: 0, w: 7, p: [10, 10] });
    dp0.emit('pic:stroke', { k: 'otra:pregunta', s: 3, n: true, c: 0, w: 0, p: [10, 10] });
    dp0.emit('pic:stroke', { k: key, s: 3, n: true, c: 0, w: 0, p: new Array(402).fill(5) });
    await wait(200);
    check('Datos malos (fuera de rango, impares, grosor raro, otra pregunta, trozo enorme) se ignoran', scr.chunks.length === 3);
    dp0.emit('pic:undo', { k: key }); await wait(200);
    scr.emit('pic:get'); const full1 = await once(scr, 'pic:full');
    check('Deshacer quita el último trazo (en directo y en el dibujo guardado)', scr.ops.length === 1 && scr.ops[0].op === 'undo' && scr.ops[0].q === 4 && full1 && full1.strokes.length === 1 && full1.strokes[0].p.length === 6, { ops: scr.ops, full1 });
    dp0.emit('pic:clear', { k: key }); await wait(200);
    scr.emit('pic:get'); const full2 = await once(scr, 'pic:full');
    check('Borrar todo vacía la pizarra', scr.ops[1] && scr.ops[1].op === 'clear' && full2.strokes.length === 0 && full2.q === 5);
    dp0.emit('pic:stroke', { k: key, s: 4, n: true, c: 2, w: 0, p: [3000, 3000, 3100, 3100] }); await wait(200);
    // El que dibuja vuelve de un corte: recupera la palabra
    dp0.words = [];
    dp0.emit('player:reconnect', { deviceId: 'pic' + T.indexOf(drawer0) }); await wait(300);
    check('Si el que dibuja se reconecta, vuelve a recibir la palabra', dp0.words.length === 1 && dp0.words[0].word === 'Torre Eiffel');

    // Pulsador
    dp0.emit('pulsar_boton'); await wait(200);
    check('El equipo que dibuja no puede pulsar', d.state.colaPulsador.length === 0);
    await wait(1100);
    others0[0].emit('pulsar_boton'); await wait(300);
    const remAtBuzz = ds().timer.remaining;
    check('Al pulsar se para el tiempo', d.state.colaPulsador.length === 1 && !ds().timer.running && ds().pictionary.pausedByBuzz === true && P[0].sync.pictionary.paused === true);
    await wait(1300);
    check('Mientras responden el tiempo no corre', ds().timer.remaining === remAtBuzz && !ds().timer.running);
    const wrongId = d.state.colaPulsador[0].id;
    cmd('director:mark_wrong', { teamId: wrongId }); await wait(300);
    check('Si falla, el tiempo sigue solo', ds().timer.running && ds().pictionary.pausedByBuzz === false);
    const winnerP = others0[1];
    const winnerId = T[P.indexOf(winnerP)];
    winnerP.emit('pulsar_boton'); await wait(300);
    const rem = d.state.colaPulsador[0].rem;
    cmd('director:mark_correct', { teamId: winnerId }); await wait(400);
    const expected = 100 + Math.floor(50 * Math.min(1, rem / 30));
    check('Acierto: puntos base + bonus por rapidez', ds().scores[winnerId] === expected, { score: ds().scores[winnerId], expected });
    check('El equipo que dibuja se lleva sus puntos', ds().scores[drawer0] === 50 && ds().pictionary.drawerPts === 50, ds().scores);
    check('Se revela: la palabra llega a todos y la pantalla ve quién acertó', P[0].sync.phase === 'answer_revealed' && P[0].sync.question.content.word === 'Torre Eiffel' && scr.sync.buzzerWinner === winnerId);
    const lqs = ds().lastQuestionScores;
    check('Resultados: el que dibujó aparece con sus puntos', lqs[drawer0] && lqs[drawer0].drawer && lqs[drawer0].points === 50 && lqs[winnerId].correct && lqs[wrongId].answer === 'Falló al pulsar', lqs);
    dp0.emit('pic:stroke', { k: key, s: 5, n: true, c: 0, w: 0, p: [10, 10] }); await wait(150);
    check('Revelada, ya no se puede dibujar', d.chunks.filter(c => c.s === 5).length === 0);
    check('Registro: empezar a dibujar y puntos por dibujar', (ds().bonoLog || []).some(e => e.action === 'pic_drawer' && e.pts === 50));

    // ── Preguntas 2 y 3: la rueda no repite ──
    const drawers = [drawer0];
    for (let qi = 1; qi <= 2; qi++) {
        cmd('director:next_question'); await wait(350);
        const pd = ds().pictionary.drawer;
        check('Pregunta ' + (qi + 1) + ': propone un equipo que aún no ha dibujado', pd && !drawers.includes(pd), { pd, drawers });
        drawers.push(pd);
        cmd('director:pic_start'); await wait(250);
        if (qi === 1) {
            // Volver atrás: la pregunta 1 se ve revelada, con su dibujo y quién lo dibujó
            byTeam(pd).emit('pic:stroke', { k: byTeam(pd).sync.questionKey, s: 1, n: true, c: 0, w: 0, p: [500, 500] }); await wait(150);
            const sc0 = JSON.stringify(ds().scores);
            cmd('director:reveal_answer'); await wait(250);
            check('«Nadie lo adivina»: se revela sin puntos para nadie', ds().phase === 'answer_revealed' && !ds().buzzerWinner && JSON.stringify(ds().scores) === sc0);
            const before = JSON.stringify(ds().scores);
            cmd('director:prev_question'); await wait(350);
            scr.emit('pic:get'); const back = await once(scr, 'pic:full');
            check('Volver a una pregunta jugada: revelada, con su dibujo y sin repuntuar', ds().phase === 'answer_revealed' && ds().pictionary.drawer === drawer0 && back && back.strokes.length === 1 && back.strokes[0].c === 2 && JSON.stringify(ds().scores) === before, back);
            cmd('director:next_question'); await wait(350);
            cmd('director:reveal_answer'); await wait(200);
        } else {
            cmd('director:reveal_answer'); await wait(200);
        }
    }
    // Pregunta 4 (2 s): se acaba el tiempo
    cmd('director:next_question'); await wait(350);
    const pd4 = ds().pictionary.drawer;
    check('Cuarta pregunta: el último equipo que faltaba', pd4 && !drawers.includes(pd4) && new Set([...drawers, pd4]).size === 4);
    check('El tiempo de la pregunta manda sobre el de la ronda', ds().timer.total === 2);
    const sc4 = JSON.stringify(ds().scores);
    cmd('director:pic_start'); await wait(2800);
    check('Se acaba el tiempo: se revela sola, sin puntos', ds().phase === 'answer_revealed' && !ds().buzzerWinner && JSON.stringify(ds().scores) === sc4);
    // Vuelta completa: la siguiente vuelta empieza de nuevo y no repite justo el último
    d.emit('director:launch_round', { roundId: rMan.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    check('Turnos «lo elige el coordinador»: no propone a nadie', ds().pictionary.drawer === null && ds().pictionary.mode === 'equipos');
    cmd('director:pic_start'); await wait(200);
    check('Sin equipo elegido no se puede empezar', ds().pictionary.step === 'setup');
    cmd('director:pic_set_drawer', { teamId: pd4 }); await wait(150);
    cmd('director:pic_start'); await wait(300);
    check('Ronda sin tiempo: empieza sin reloj', ds().pictionary.step === 'drawing' && ds().timer.total === 0 && !ds().timer.running);
    check('Vuelta completa: la rueda empieza otra', (ds().picDone || []).length === 1 && ds().picDone[0] === pd4, ds().picDone);
    const g2 = T.find(t => t !== pd4);
    byTeam(g2).emit('pulsar_boton'); await wait(250);
    const s0 = ds().scores[g2] || 0;
    cmd('director:mark_correct', { teamId: g2 }); await wait(300);
    check('Sin tiempo: el acierto suma solo los puntos base; sin puntos para el que dibuja si la ronda no los da', ds().scores[g2] - s0 === 80 && !ds().pictionary.drawerPts);

    // ── Pizarra fija ──
    const link = await new Promise(r => { d.once('director:pic_pad_link', r); d.emit('director:pic_pad_link'); });
    check('El coordinador obtiene el enlace de la pizarra', link && link.key && link.pass === pass && link.gameId === g.id);
    const bad = io(B, { query: { gameId: g.id, pass }, transports: ['websocket'], forceNew: true });
    await connected(bad); bad.emit('pad:join', { key: 'falsa' });
    check('Una llave falsa no enlaza la pizarra', !!(await once(bad, 'pad:rejected')) && !ds().padConnected);
    const pad = io(B, { query: { gameId: g.id, pass }, transports: ['websocket'], forceNew: true });
    pad.words = []; pad.on('pic:word', w => pad.words.push(w)); pad.on('game:player_sync', s => { pad.sync = s; });
    await connected(pad); pad.emit('pad:join', { key: link.key });
    check('La pizarra se enlaza con la llave del QR', !!(await once(pad, 'pad:ok')));
    await wait(200);
    check('El coordinador ve la pizarra conectada', ds().padConnected === true);
    d.emit('director:launch_round', { roundId: rPad.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    check('Modo pizarra: nadie de los equipos dibuja', ds().pictionary.mode === 'ipad' && ds().pictionary.drawer === null);
    const pw = P.map(p => p.words.length);
    cmd('director:pic_start'); await wait(300);
    check('La palabra llega a la pizarra y a ningún equipo', pad.words.length === 1 && pad.words[0].word === 'Avión' && P.every((p, i) => p.words.length === pw[i]));
    const kp = pad.sync.questionKey;
    const n0 = scr.chunks.length;
    P[0].emit('pic:stroke', { k: kp, s: 1, n: true, c: 0, w: 0, p: [10, 10] });
    pad.emit('pic:stroke', { k: kp, s: 1, n: true, c: 3, w: 1, p: [400, 400, 500, 500] }); await wait(250);
    check('Dibuja la pizarra, no los equipos', scr.chunks.length === n0 + 1 && scr.chunks[n0].c === 3);
    P.forEach(p => p.emit('pulsar_boton')); await wait(300);
    check('Pulsan todos los equipos', d.state.colaPulsador.length === 4);
    const first = d.state.colaPulsador[0].id;
    const sb = JSON.parse(JSON.stringify(ds().scores));
    cmd('director:mark_correct', { teamId: first }); await wait(300);
    check('Con pizarra solo suma quien acierta (la pizarra no es de nadie)', ds().scores[first] - (sb[first] || 0) === 100 && T.filter(t => t !== first).every(t => ds().scores[t] === sb[t]));
    const pad2 = io(B, { query: { gameId: g.id, pass }, transports: ['websocket'], forceNew: true });
    await connected(pad2);
    const replaced = once(pad, 'pad:replaced');
    pad2.emit('pad:join', { key: link.key });
    check('Si se abre en otro iPad, el anterior deja de ser la pizarra', !!(await replaced));
    pad2.close(); await wait(300);
    check('Al cerrarse la pizarra, el coordinador lo ve', ds().padConnected === false);

    // ── La rueda se guarda con la partida ──
    const doneBefore = JSON.stringify(ds().picDone);
    await wait(2300); // se guarda cada 2 s
    [d, scr, pad, bad, ...P].forEach(s => s.close());
    server.kill(); await wait(800);
    await startServer();
    const d2 = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d2.on('game:director_sync', s => { d2.state = s; }); d2.on('connect', () => d2.emit('director:join'));
    await connected(d2); await wait(500);
    check('Tras reiniciar el servidor la rueda de turnos sigue igual', JSON.stringify(d2.state.director.picDone) === doneBefore, { antes: doneBefore, despues: d2.state.director.picDone });
    d2.close();

    // ── Excel ──
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const ex = XLSX.read(Buffer.from(await (await fetch(B + `/api/games/${g.id}/export-excel`, { headers: { cookie } })).arrayBuffer()));
    const rows = XLSX.utils.sheet_to_json(ex.Sheets['Pictionary'], { header: 1 }).slice(3);
    check('Exportar: una fila por palabra con las opciones de la ronda', rows.length === 6 && rows[0][1] === 'Torre Eiffel' && rows[0][2] === 'Monumentos' && rows[0][3] === 'equipo' && rows[0][5] === 50 && rows[5][3] === 'ipad' && rows[4][4] === 'coordinador' && rows[3][6] === 2, rows);
    const gx = (await api('/games', { method: 'POST', body: { name: 'Import' } })).data;
    const fx = new FormData(); fx.append('file', new Blob([XLSX.write(ex, { type: 'buffer', bookType: 'xlsx' })]), 'p.xlsx');
    const imp = await (await fetch(B + `/api/games/${gx.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } })).json();
    const tx = (await api(`/games/${gx.id}`)).data;
    const rx = (n) => tx.rounds.find(r => r.name === n);
    check('Importar lo exportado: mismas rondas, palabras y opciones', !imp.errors.length && !imp.incomplete.length && rx('Equipos').questions.length === 4 && rx('Equipos').config.picDrawerPoints === 50 && rx('Equipos').config.picMode === 'equipos'
        && rx('A mano').config.picTurns === 'manual' && rx('A mano').config.time === 0 && rx('Pizarra').config.picMode === 'ipad' && rx('Equipos').questions[3].config.time === 2, { imp, cfg: tx.rounds.map(r => r.config) });
    // Pestaña sin hoja Rondas (formato antiguo): 60 s por defecto y opciones desde las filas
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['t'], [], ['h'],
        ['R', 'Perro', '', 'pizarra', '', 30], ['R', 'Gato'], ['R', '', 'Animales']]), 'Pictionary');
    const gy = (await api('/games', { method: 'POST', body: { name: 'Import2' } })).data;
    const fy = new FormData(); fy.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'y.xlsx');
    const impY = await (await fetch(B + `/api/games/${gy.id}/import-excel`, { method: 'POST', body: fy, headers: { cookie } })).json();
    const ry = (await api(`/games/${gy.id}`)).data.rounds[0];
    check('Excel sin hoja Rondas: 60 s, pizarra fija y la palabra que falta, incompleta', ry.config.time === 60 && ry.config.picMode === 'ipad' && ry.config.picDrawerPoints === 30 && ry.questions.length === 3 && impY.incomplete.length === 1 && impY.incomplete[0].missing.includes('word'), { cfg: ry.config, inc: impY.incomplete });

    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
