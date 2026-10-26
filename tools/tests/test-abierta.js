// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-abierta.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Respuesta abierta: pasos (enunciado → subpreguntas → respondiendo → corrigiendo → revelado),
// borrador en el servidor, corrección automática (sin mayúsculas, tildes ni signos), corrección a
// mano por grupos, puntos proporcionales + bonus al mejor (empate: el que envió antes), revelado
// por subpreguntas, rectificar después, cuenta atrás opcional, cierre automático y Excel.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3211;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-abierta');
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
    // ── Reglas compartidas: comparar respuestas y validar ──
    const QV = require(path.join(REPO, 'public/shared/question-validation.js'));
    const sub = { answer: 'Cervantes', alts: 'Miguel de Cervantes / el manco de Lepanto' };
    check('Da igual mayúsculas, tildes, signos y espacios', QV.matchesSub('  ¡cervántes!  ', sub) && QV.matchesSub('MIGUEL DE  CERVANTES.', sub) && QV.matchesSub('el Manco de lepanto', sub));
    check('La ñ cuenta como n y lo distinto no vale', QV.matchesSub('espana', { answer: 'España' }) && !QV.matchesSub('Quevedo', sub) && !QV.matchesSub('', sub));
    check('Validación: hace falta al menos una subpregunta con texto y respuesta',
        !QV.isComplete('abierta', { subs: [] }).complete && !QV.isComplete('abierta', { subs: [{ text: 'a' }] }).complete && QV.isComplete('abierta', { subs: [{ text: 'a', answer: 'b' }] }).complete);

    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Abierta', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const SUBS = [
        { text: '¿Quién escribió El Quijote?', answer: 'Cervantes', alts: 'Miguel de Cervantes / el manco de Lepanto' },
        { text: '¿Capital de Portugal?', answer: 'Lisboa' },
        { text: '¿Lados de un hexágono?', answer: '6', alts: 'seis' },
    ];
    const rA = await mk('Lo sabe', 'abierta', { points: 90 }, [
        { statement: 'Cultura general', subs: SUBS },
        { statement: 'Segunda', subs: [{ text: '¿2+2?', answer: '4' }] },
    ]);
    const rT = await mk('Con tiempo', 'abierta', { points: 100, fastestExtra: false }, [{ subs: [{ text: '¿Color del cielo?', answer: 'azul' }], time: 3 }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const scr = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true });
    scr.on('game:player_sync', s => { scr.sync = s; });
    await connected(scr); scr.emit('screen:join', {});
    const P = [];
    for (let i = 0; i < 3; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'ab' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'ab' + i }); P.push(p);
        await wait(80); // orden de llegada estable
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);
    const ds = () => d.state.director;
    const score = (i) => ds().scores[T[i]] || 0;

    // ── Paso 1: solo el enunciado general ──
    d.emit('director:launch_round', { roundId: rA.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const c0 = P[0].sync.question.content;
    check('Al lanzar: iPads y pantalla ven el enunciado, aún sin subpreguntas', P[0].sync.abierta.step === 'intro' && c0.subs.length === 0 && c0.nSubs === 3 && scr.sync.question.content.subs.length === 0);
    check('Sin cuenta atrás: el reloj no corre', ds().timer.total === 0 && !ds().timer.running);
    P[0].emit('player:abierta_draft', { texts: ['x', '', ''] }); await wait(150);
    check('Antes de abrir no se puede escribir', !ds().answers[T[0]]);

    // ── Paso 2: subpreguntas a la vista, sin soluciones ──
    cmd('director:abierta_show'); await wait(300);
    const c1 = P[0].sync.question.content, cs = scr.sync.question.content;
    check('Mostrar subpreguntas: se ven los textos', c1.subs.length === 3 && c1.subs[0].text === SUBS[0].text && P[0].sync.abierta.step === 'shown');
    check('Ni iPads ni pantalla reciben respuestas ni otras válidas', [c1, cs].every(c => c.subs.every(s => s.answer === undefined && s.alts === undefined)));
    P[0].emit('player:abierta_submit', { texts: ['a', 'b', 'c'] }); await wait(150);
    check('Con las subpreguntas a la vista aún no se puede enviar', !ds().answers[T[0]]);

    // ── Paso 3: respondiendo ──
    cmd('director:abierta_open'); await wait(300);
    check('Abrir respuestas', P[0].sync.abierta.step === 'open');
    P[0].emit('player:abierta_draft', { texts: ['cervántes', 'Lis'] }); await wait(200);
    // (el borrador no se reenvía a nadie con cada tecla: se comprueba al reconectar, justo debajo)
    check('El borrador no cuenta como enviado', !(P[0].sync.answeredTeams || []).includes(T[0]));
    const got = await new Promise(res => { P[0].once('game:your_abierta', res); P[0].emit('player:register_team', { name: 'Equipo 0', deviceId: 'ab0' }); setTimeout(() => res(null), 1500); });
    check('Al reconectar, el iPad recupera lo que tenía escrito', got && got.texts[0] === 'cervántes' && got.texts[1] === 'Lis' && got.submitted === false, got);
    P[0].emit('player:abierta_submit', { texts: ['cervántes', 'Lisboa', '7'] }); await wait(200);
    P[1].emit('player:abierta_submit', { texts: ['Miguel de Cervantes', 'lisboa.', 'Seis'] }); await wait(200);
    P[2].emit('player:abierta_draft', { texts: ['Quevedo', 'LISBOA', '6'] }); await wait(200);
    check('Cuentan los envíos (2 de 3) y sigue abierta', ds().answeredCount === 2 && P[0].sync.abierta.step === 'open' && scr.sync.answeredTeams.length === 2);
    P[0].emit('player:abierta_submit', { texts: ['otra', 'cosa', 'x'] }); await wait(150);
    check('Lo enviado no se puede cambiar', ds().answers[T[0]].answer[0] === 'cervántes');

    // ── Paso 4: cerrar y corregir ──
    cmd('director:abierta_close'); await wait(300);
    const A = ds().abierta;
    check('Cerrar respuestas: empieza la corrección', A.step === 'correcting' && P[0].sync.abierta.step === 'correcting' && scr.sync.abierta.step === 'correcting');
    check('Lo escrito sin enviar cuenta (y pierde el desempate)', ds().answers[T[2]].submitted === true && ds().answers[T[2]].late === true);
    check('Corrección automática', JSON.stringify(A.marks[T[0]]) === '[true,true,false]' && JSON.stringify(A.marks[T[1]]) === '[true,true,true]' && JSON.stringify(A.marks[T[2]]) === '[false,true,true]', A.marks);
    P[2].emit('player:abierta_submit', { texts: ['a', 'b', 'c'] }); await wait(150);
    check('Cerrada, ya no se acepta nada', ds().answers[T[2]].answer[0] === 'Quevedo');
    cmd('director:abierta_mark', { sub: 0, teamIds: [T[2]], ok: true }); await wait(250);
    check('Control da por buena una respuesta (Quevedo → ✓)', ds().abierta.marks[T[2]][0] === true);
    cmd('director:abierta_mark', { sub: 9, teamIds: [T[2]], ok: true }); await wait(150);
    check('Subpregunta inexistente: se ignora', ds().abierta.marks[T[2]].length === 3);
    check('Corregir no toca el marcador', score(0) === 0 && score(1) === 0 && score(2) === 0);

    // ── Paso 5: revelar subpregunta a subpregunta ──
    cmd('director:abierta_reveal'); await wait(300);
    check('Revelar: empieza sin nada destapado y sin puntos', ds().phase === 'answer_revealed' && P[0].sync.abierta.revealStep === 0 && P[0].sync.question.content.subs.every(s => s.answer === undefined) && score(1) === 0);
    const l0 = P[0].sync.lastQuestionScores[T[0]];
    check('El iPad aún no sabe sus aciertos ni sus puntos', l0.pending === true && l0.marks.length === 0 && l0.points === undefined && Array.isArray(l0.answer), l0);
    d.emit('director:reveal_next_pair'); await wait(300);
    const l1 = P[0].sync.lastQuestionScores[T[0]];
    check('Primera subpregunta: se ve su respuesta y vuestro verde/rojo', P[0].sync.question.content.subs[0].answer === 'Cervantes' && P[0].sync.question.content.subs[1].answer === undefined && JSON.stringify(l1.marks) === '[true]');
    d.emit('director:reveal_next_pair'); await wait(250);
    check('A mitad del revelado los puntos siguen esperando', score(0) === 0 && score(1) === 0);
    d.emit('director:reveal_next_pair'); await wait(300);
    d.emit('director:reveal_next_pair'); await wait(200);
    // 90 base, 3 subpreguntas: 2/3 → 60, 3/3 → 90; empate a 3 (E1 y E2): gana E1, que envió antes → +30
    check('Puntos al destapar la última: proporcional + extra (+10 %) al mejor (empate: el que envió antes)', score(0) === 60 && score(1) === 99 && score(2) === 90, { e0: score(0), e1: score(1), e2: score(2) });
    const lq = P[1].sync.lastQuestionScores[T[1]];
    check('El iPad ve sus aciertos, sus puntos y el extra', lq.correctCount === 3 && lq.points === 99 && lq.winner === true && !lq.pending, lq);

    // ── Rectificar con la pregunta ya puntuada ──
    cmd('director:abierta_mark', { sub: 2, teamIds: [T[1]], ok: false }); await wait(300);
    check('Rectificar: se recalcula todo (también el extra) y solo va la diferencia', score(0) === 60 && score(1) === 60 && score(2) === 99, { e0: score(0), e1: score(1), e2: score(2) });
    cmd('director:abierta_mark', { sub: 0, teamIds: [T[2]], ok: false }); await wait(300);
    check('Empate a 2 entre los tres: el extra es para el que envió antes', score(0) === 69 && score(1) === 60 && score(2) === 60, { e0: score(0), e1: score(1), e2: score(2) });
    const log = await new Promise(res => { d.once('director:log', res); d.emit('director:get_log'); });
    const fixes = log.log.filter(e => e.action === 'abierta_fix');
    check('Las rectificaciones quedan en el registro', fixes.length === 2 && fixes[1].changes.some(ch => ch.pts === 9) && log.log.some(e => e.action === 'abierta_closed'));

    // ── Siguiente pregunta: cierre automático y trabajo a medias ──
    cmd('director:next_question'); await wait(300);
    check('La siguiente vuelve al enunciado', P[0].sync.abierta.step === 'intro' && P[0].sync.phase === 'question');
    cmd('director:abierta_open'); await wait(250);
    check('Abrir directamente (sin mostrar antes) también enseña las subpreguntas', P[0].sync.question.content.subs.length === 1 && P[0].sync.abierta.step === 'open');
    P[0].emit('player:abierta_submit', { texts: ['4'] }); await wait(100);
    P[1].emit('player:abierta_submit', { texts: ['cuatro'] }); await wait(100);
    check('Con equipos sin enviar no se cierra', ds().abierta.step === 'open');
    P[2].emit('player:abierta_submit', { texts: ['  '] }); await wait(150);
    check('Un envío en blanco no cuenta', !ds().answers[T[2]] || ds().answers[T[2]].submitted === false);
    P[2].emit('player:abierta_submit', { texts: ['5'] }); await wait(300);
    check('Cuando envían todos, se pasa sola a corregir', ds().abierta.step === 'correcting' && P[2].sync.abierta.step === 'correcting');
    cmd('director:abierta_mark', { sub: 0, teamIds: [T[1]], ok: true }); await wait(200);
    cmd('director:prev_question'); await wait(400);
    check('Volver a la anterior: revelada del todo y sin repuntuar', P[0].sync.phase === 'answer_revealed' && P[0].sync.abierta.revealStep === 3 && score(0) === 69 && score(1) === 60, { e0: score(0), e1: score(1) });
    cmd('director:next_question'); await wait(400);
    check('La que estaba a medio corregir se recupera tal cual', ds().abierta.step === 'correcting' && ds().abierta.marks[T[1]][0] === true && ds().answers[T[0]].answer[0] === '4');

    // ── Con cuenta atrás: al acabarse, a corregir ──
    d.emit('director:launch_round', { roundId: rT.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    check('Con cuenta atrás: el reloj espera a «Abrir respuestas»', ds().timer.total === 3 && !ds().timer.running && P[0].sync.timer.total === 3);
    d.emit('director:start_timer'); await wait(200);
    check('El botón de tiempo no abre las respuestas', !ds().timer.running && ds().abierta.step === 'intro');
    cmd('director:abierta_open'); await wait(300);
    check('Al abrir arranca la cuenta atrás', ds().timer.running);
    P[0].emit('player:abierta_draft', { texts: ['Azul'] }); await wait(3600);
    check('Al acabarse el tiempo se cierra y lo escrito cuenta', ds().abierta.step === 'correcting' && ds().answers[T[0]].late === true && ds().abierta.marks[T[0]][0] === true);

    // ── Excel: plantilla con ejemplo, importar y exportar ──
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const tpl = Buffer.from(await (await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } })).arrayBuffer());
    const gx = (await api('/games', { method: 'POST', body: { name: 'Excel' } })).data;
    const fx = new FormData(); fx.append('file', new Blob([tpl]), 'ej.xlsx');
    const imp = await (await fetch(B + `/api/games/${gx.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } })).json();
    const tree = (await api(`/games/${gx.id}`)).data;
    const ra = tree.rounds.find(r => r.type === 'abierta');
    const qa = ra && ra.questions[0];
    check('Plantilla con ejemplo: se importa una pregunta con 3 subpreguntas', qa && qa.content.subs.length === 3 && ra.questions.length === 1 && !imp.errors.length, imp.errors);
    check('Otras válidas en una celda separadas por /, tiempo, puntos y extra', qa && qa.content.subs[0].alts.includes('/') && qa.content.time === 90 && qa.config.points === 500 && qa.config.fastestExtra === true, qa && { c: qa.content, cfg: qa.config });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['t'], [], ['h'],
        ['R1', '', 'P1', 'r1', '', '', '', ''], ['R1', '', 'P2', 'r2', 'a / b'],
        ['R1', 'Otra pregunta', 'P3', ''], ['R2', '', 'Q1', 'x']]), 'Respuesta abierta');
    const gy = (await api('/games', { method: 'POST', body: { name: 'Excel2' } })).data;
    const fy = new FormData(); fy.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'y.xlsx');
    const impY = await (await fetch(B + `/api/games/${gy.id}/import-excel`, { method: 'POST', body: fy, headers: { cookie } })).json();
    const ty = (await api(`/games/${gy.id}`)).data;
    const r1 = ty.rounds.find(r => r.name === 'R1');
    check('Excel: enunciado nuevo = pregunta nueva; sin tiempo = sin cuenta atrás', r1.questions.length === 2 && r1.questions[0].content.subs.length === 2 && r1.questions[0].content.time === undefined && ty.rounds.length === 2);
    check('Excel: subpregunta sin respuesta = pregunta incompleta', impY.incomplete.length === 1 && impY.incomplete[0].missing.includes('sub_items'), impY.incomplete);
    const ex = XLSX.read(Buffer.from(await (await fetch(B + `/api/games/${g.id}/export-excel`, { headers: { cookie } })).arrayBuffer()));
    const rowsEx = XLSX.utils.sheet_to_json(ex.Sheets['Respuesta abierta'], { header: 1 }).slice(3);
    check('Exportar: una fila por subpregunta con sus válidas', rowsEx.length === 5 && rowsEx[0][1] === 'Cultura general' && rowsEx[0][4] === SUBS[0].alts && rowsEx[2][2] === SUBS[2].text, rowsEx.slice(0, 3));

    [d, scr, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
