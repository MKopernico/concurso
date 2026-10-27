// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteF-informe.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Informe del 15/10: en las pruebas de pulsador el resumen «Resultados por equipo» dice quién
// acertó (con sus puntos) y quién falló; en «Imagen que se aclara» el coordinador puede mostrar
// la respuesta en la pantalla durante la pregunta.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3210;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteF');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'Informe', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rPu = await mk('Pulsador', 'pulsador', { basePoints: 100, penalty: 20 }, [{ statement: '¿2+2?', answer: '4' }]);
    const rAc = await mk('Aclara', 'aclara', { basePoints: 100, penalty: 0 }, [{ image: '/uploads/images/prueba.png', answer: 'Torre Eiffel', effect: 'pixel', mode: 'manual', duration: 10 }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await wait(400);
    const cmd = (ev, data = {}) => d.emit(ev, { ...data, at: d.state.director.currentQuestionIdx, round: d.state.director.currentRoundId });
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const scr = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true });
    scr.sync = null; scr.ans = null;
    scr.on('game:player_sync', s => { scr.sync = s; }); scr.on('game:image_answer_updated', a => { scr.ans = a; });
    await connected(scr); scr.emit('screen:join', {});
    const P = [];
    for (let i = 0; i < 3; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'f' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'f' + i }); P.push(p);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);

    // ── Pulsador: uno falla, otro acierta, el tercero no pulsa ──
    d.emit('director:launch_round', { roundId: rPu.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:open_buzzer'); await wait(200);
    P[0].emit('pulsar_boton'); await wait(150);
    P[1].emit('pulsar_boton'); await wait(250);
    cmd('director:mark_wrong', { teamId: T[0] }); await wait(250);
    check('El que falló queda marcado y su iPad lo sabe (pulsador gris)', (P[0].sync.buzzerFailed || []).includes(T[0]));
    cmd('director:mark_correct', { teamId: T[1] }); await wait(400);
    const lq = d.state.director.lastQuestionScores;
    check('Resultados: el que acertó sale con sus puntos', lq[T[1]] && lq[T[1]].correct === true && lq[T[1]].points === 100 && !lq[T[1]].noAnswer, lq[T[1]]);
    check('Resultados: el que falló sale como fallo con la penalización', lq[T[0]] && lq[T[0]].correct === false && lq[T[0]].points === -20 && !lq[T[0]].noAnswer, lq[T[0]]);
    check('Resultados: el que no pulsó sale sin respuesta', lq[T[2]] && lq[T[2]].noAnswer === true, lq[T[2]]);
    check('El marcador coincide con los resultados', d.state.director.scores[T[1]] === 100 && d.state.director.scores[T[0]] === -20, d.state.director.scores);

    // ── Imagen que se aclara: mostrar la respuesta en pantalla y resultados ──
    d.emit('director:launch_round', { roundId: rAc.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    d.emit('director:image_toggle_answer', { visible: true }); await wait(300);
    check('«Mostrar respuesta» la manda a la pantalla', scr.ans && scr.ans.visible === true && scr.ans.answer === 'Torre Eiffel', scr.ans);
    check('La pantalla la tiene en su estado (por si se recarga)', scr.sync && scr.sync.imagePuzzle && scr.sync.imagePuzzle.answerVisible === true);
    d.emit('director:image_toggle_answer', { visible: false }); await wait(300);
    check('«Ocultar respuesta» la quita', scr.ans && scr.ans.visible === false);
    d.emit('director:aclara_set', { level: 0.5 }); await wait(250);
    P[2].emit('pulsar_boton'); await wait(300);
    cmd('director:mark_correct', { teamId: T[2] }); await wait(400);
    const la = d.state.director.lastQuestionScores;
    check('Aclara: el acierto sale en resultados con los puntos que valía', la[T[2]] && la[T[2]].correct && la[T[2]].points === 50 && d.state.director.scores[T[2]] === 50, la[T[2]]);
    check('Aclara: la respuesta oculta de la pregunta anterior no se arrastra', scr.sync.imagePuzzle.answerVisible === false);

    // ── Plantilla Excel con ejemplos: se descarga, se importa tal cual y salen las 10 pruebas ──
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const tplRes = await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } });
    const tplBuf = Buffer.from(await tplRes.arrayBuffer());
    check('La plantilla con ejemplos se descarga con su nombre', /con_ejemplos/.test(tplRes.headers.get('content-disposition') || ''));
    const twb = XLSX.read(tplBuf);
    check('Trae ejemplos en Rondas y en cada pestaña', XLSX.utils.sheet_to_json(twb.Sheets['Rondas'], { header: 1 }).length === 16);
    const gEj = (await api('/games', { method: 'POST', body: { name: 'Ejemplos' } })).data;
    const fEj = new FormData(); fEj.append('file', new Blob([tplBuf]), 'ej.xlsx');
    const impEj = await (await fetch(B + `/api/games/${gEj.id}/import-excel`, { method: 'POST', body: fEj, headers: { cookie } })).json();
    const tEj = (await api(`/games/${gEj.id}`)).data;
    const tipos = tEj.rounds.map(r => r.type).sort().join(',');
    check('Al importarla se crean 13 rondas, una de cada tipo, sin errores', tEj.rounds.length === 13 && tipos === 'abierta,aclara,boom,cancion,cifras,identidad,imagen,imagen_fija,multirespuesta,pictionary,precio,pulsador,ruleta' && !impEj.errors.length, { tipos, errores: impEj.errors });
    const rq = (t) => tEj.rounds.find(r => r.type === t).questions[0].content;
    check('Ejemplos correctos: Multirespuesta (Tajo), Boom (rueda primero), Identidad (4 parejas)', rq('multirespuesta').options[rq('multirespuesta').correct[0]] === 'Tajo' && rq('boom').items[rq('boom').correct_order[0]] === 'Rueda' && rq('identidad').pairs.length === 4);
    const img = await fetch(B + '/shared/ejemplo-paisaje.svg');
    check('La imagen de muestra viene con la app', img.ok && /svg/.test(img.headers.get('content-type') || ''));
    const plain = await fetch(B + '/api/templates/importacion', { headers: { cookie } });
    const pwb = XLSX.read(Buffer.from(await plain.arrayBuffer()));
    check('La plantilla normal sigue vacía', XLSX.utils.sheet_to_json(pwb.Sheets['Rondas'], { header: 1 }).length === 3);

    // Precio justo desde Excel: valor vacío = incompleta (antes entraba como 0); un 0 escrito vale
    const wbP = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbP, XLSX.utils.aoa_to_sheet([['t'], [], ['h'], ['Precios', '¿Vacío?', ''], ['Precios', '¿Cero?', 0]]), 'Precio Justo');
    const gP = (await api('/games', { method: 'POST', body: { name: 'Precios' } })).data;
    const fP = new FormData(); fP.append('file', new Blob([XLSX.write(wbP, { type: 'buffer', bookType: 'xlsx' })]), 'p.xlsx');
    const impP = await (await fetch(B + `/api/games/${gP.id}/import-excel`, { method: 'POST', body: fP, headers: { cookie } })).json();
    const qsP = (await api(`/games/${gP.id}`)).data.rounds[0].questions.map(q => q.content.correct_value);
    check('Precio con valor vacío entra como incompleto, no como 0', impP.incomplete.length === 1 && qsP[0] === undefined && qsP[1] === 0, { incompletas: impP.incomplete.length, valores: qsP });

    [d, scr, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
