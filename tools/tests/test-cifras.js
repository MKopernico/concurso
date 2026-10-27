// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-cifras.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Cifras: motor (cuentas válidas, mejor resultado, solucionador, generador por niveles), números
// visibles pero sin operar hasta abrir, sin solución en iPads ni pantalla, borrador y reenvío,
// reconexión, cierre (el borrador cuenta), puntos por cercanía y rapidez con extra al más cercano,
// revelado por grupos del más lejano al más cercano (los puntos al final), solución si nadie la
// clava, «usar todas», congelados, volver a una pregunta ya jugada y Excel (importar con nivel y exportar).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const APP = process.env.GAMESHOW_TEST_APP || REPO;
const PORT = 3232;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-cifras');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // ── Motor (sin servidor) ──
    const C = require(path.join(REPO, 'public/shared/cifras.js'));
    const e1 = C.evaluate([25, 4, 7, 3], [[0, '*', 1], [2, '-', 3], [4, '-', 5]], 96, false);
    check('Motor: cuentas encadenadas y resultado exacto', e1.best && e1.best.value === 96 && e1.best.dist === 0 && e1.path.length === 3 && !e1.error, e1.best);
    check('Motor: un número ya usado no vale', C.evaluate([25, 4, 7, 3], [[0, '*', 1], [0, '+', 3]], 96).error === 'paso no válido');
    check('Motor: división no exacta y resta que no da positivo no valen', /exacta/.test(C.evaluate([25, 4], [[0, '/', 1]], 6).error) && /cero/.test(C.evaluate([4, 25], [[0, '-', 1]], 6).error));
    const e2 = C.evaluate([25, 4, 7, 3], [[0, '*', 1], [2, '+', 3]], 95, false);
    check('Motor: el más cercano y, empatados, el de menos cuentas', e2.best.value === 100 && e2.path.length === 1, e2.best);
    check('Motor: un número de partida también vale', C.evaluate([25, 4], [], 24).best.value === 25);
    check('Motor: con «usar todas» solo cuenta lo que usa todos', C.evaluate([25, 4, 7, 3], [[0, '*', 1]], 100, true).best === null
        && C.evaluate([25, 4, 7, 3], [[0, '*', 1], [2, '-', 3], [4, '-', 5]], 100, true).best.value === 96);
    const sol = C.solve([1, 3, 7, 10, 25, 50], 765);
    check('Solucionador: encuentra una exacta y la comprueba el motor', sol && sol.dist === 0 && sol.steps.every(s => C.apply(s.a, s.op, s.b) === s.r) && sol.steps[sol.steps.length - 1].r === 765, sol);
    const imp = C.solve([1, 1, 2, 2, 3, 3], 999);
    check('Solucionador: si no hay exacta, la más cercana (81)', imp.value === 81 && imp.dist === 918);
    const lv = ['facil', 'medio', 'dificil'].map(l => { const t = Date.now(); const g = C.generate(l); return { l, g, ms: Date.now() - t }; });
    check('Generador: los tres niveles salen con solución exacta de más de un paso', lv.every(({ l, g }) => g && C.LEVELS[l].count === g.numbers.length && g.target >= C.LEVELS[l].min && g.target <= C.LEVELS[l].max
        && C.evaluate(g.numbers, [], g.target).best.dist > 0 && g.solution.length >= 2 && g.solution[g.solution.length - 1].r === g.target), lv.map(x => [x.l, x.g && x.g.target, x.g && x.g.numbers.join(' '), x.ms + ' ms']));

    // ── Partida ──
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Cifras', status: 'published' } })).data;
    const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Cifras', type: 'cifras', config: { time: 60, points: 500, fastestExtra: true } } })).data;
    const Q = [
        { target: 96, numbers: [25, 4, 7, 3], solution: [{ a: 25, op: '*', b: 4, r: 100 }, { a: 7, op: '-', b: 3, r: 4 }, { a: 100, op: '-', b: 4, r: 96 }] },
        { target: 50, numbers: [1, 2] },
        { target: 100, numbers: [25, 4, 7, 3], useAll: true },
    ];
    for (const c of Q) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } });
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
    for (let i = 0; i < 4; i++) {
        const p = io(B, { query: { gameId: g.id, deviceId: 'cf' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'cf' + i }); P.push(p);
        await wait(80);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);
    const ds = () => d.state.director;
    const score = (i) => ds().scores[T[i]] || 0;
    const send = (i, steps, final) => P[i].emit('player:cifras', { steps, final: !!final });

    d.emit('director:launch_round', { roundId: r.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const c0 = P[0].sync.question.content;
    check('Al lanzar: iPads y pantalla ven objetivo y números', c0.target === 96 && c0.numbers.join() === '25,4,7,3' && scr.sync.question.content.target === 96);
    check('Ni iPads ni pantalla reciben la solución', c0.solution === undefined && scr.sync.question.content.solution === undefined);
    check('Tiempo de la ronda (60 s) y parado', ds().timer.total === 60 && !ds().timer.running);
    send(0, [[0, '*', 1]], true); await wait(200);
    check('Antes de abrir no se puede enviar', !ds().answers[T[0]]);

    d.emit('director:start_timer'); await wait(300);
    check('▶ del tiempo abre las cuentas', ds().optionsRevealed && ds().timer.running && P[0].sync.optionsRevealed);
    send(0, [[0, '*', 1], [2, '-', 3], [4, '-', 5]], true); await wait(150);         // 96: exacto
    send(1, [[0, '+', 1]], true); await wait(150);                                    // 29
    send(1, [[0, '*', 1]], true); await wait(150);                                    // reenvía: 100 (a 4)
    send(2, [[0, '+', 2]], false); await wait(150);                                    // solo borrador: 32 (a 64)
    send(3, [[0, '/', 2], [0, '+', 1]], true); await wait(200);                       // la división no vale: se queda en nada → 25
    check('Envíos: cuentan 3 (el borrador no) y la pantalla lo sabe', ds().answeredCount === 3 && scr.sync.cifrasSent === 3, { n: ds().answeredCount, s: scr.sync.cifrasSent });
    check('El reenvío sustituye al anterior', JSON.stringify(ds().answers[T[1]].answer) === JSON.stringify([[0, '*', 1]]));
    check('Los pasos que no valen se quitan (y lo que sigue a uno malo también)', JSON.stringify(ds().answers[T[3]].answer) === '[]');
    send(0, [[0, '*', 1], [2, '-', 3], [4, '-', 5], [6, '*', 0]], false); await wait(150);
    check('Seguir haciendo cuentas tras enviar no cambia lo enviado', ds().answers[T[0]].answer.length === 3 && ds().answers[T[0]].submitted);
    const got = await new Promise(res => { P[2].once('game:your_cifras', res); P[2].emit('player:register_team', { name: 'Equipo 2', deviceId: 'cf2' }); setTimeout(() => res(null), 1500); });
    check('Al reconectar, el iPad recupera sus cuentas', got && JSON.stringify(got.steps) === JSON.stringify([[0, '+', 2]]) && got.sent === null, got);
    d.emit('director:block_team', { teamId: T[3] }); await wait(100);

    cmd('director:reveal_answer'); await wait(400);
    const cf = ds().cifras;
    check('Al cerrar, el borrador cuenta como enviado al final', ds().answers[T[2]].submitted && ds().answers[T[2]].late);
    check('Grupos del más lejano al más cercano', cf && cf.groups.map(x => x.dist).join() === '71,64,4,0' && cf.total === 4, cf && cf.groups);
    const pts = cf.points;
    check('Puntos: exacto con rapidez + extra; a 4 = 60 % ; a 64 o 71 = nada', pts[T[0]] > 450 && pts[T[0]] <= 550 && pts[T[1]] > 150 && pts[T[1]] <= 300 && pts[T[2]] === 0 && pts[T[3]] === 0 && cf.winner === T[0], pts);
    check('Los puntos esperan al último paso', score(0) === 0);
    const lq = P[1].sync.lastQuestionScores;
    check('iPads: nada destapado ni puntos durante el revelado', lq[T[0]].pending && lq[T[0]].value === undefined && lq[T[1]].value === undefined);
    d.emit('director:reveal_next_pair'); d.emit('director:reveal_next_pair'); await wait(300);
    const lq2 = P[1].sync.lastQuestionScores;
    check('Tras dos pasos se ven los dos grupos más lejanos, sin puntos', lq2[T[3]].value === 25 && lq2[T[2]].value === 32 && lq2[T[2]].points === 0 && lq2[T[0]].value === undefined && P[1].sync.cifras.revealStep === 2);
    check('La pantalla ve los resultados con sus cuentas', scr.sync.lastQuestionScores[T[0]].path.length === 3 && scr.sync.cifras.solution === null);
    d.emit('director:reveal_next_pair'); d.emit('director:reveal_next_pair'); await wait(300);
    check('Último paso: suman los puntos y se ve el ganador', score(0) === pts[T[0]] && score(1) === pts[T[1]] && P[0].sync.cifras.winner === T[0] && P[0].sync.lastQuestionScores[T[0]].points === pts[T[0]] && P[0].sync.lastQuestionScores[T[0]].winner);
    d.emit('director:reveal_next_pair'); await wait(200);
    check('Un paso de más no hace nada', ds().cifras.revealStep === 4 && score(0) === pts[T[0]]);
    d.emit('director:unblock_team', { teamId: T[3] }); await wait(100);

    // ── Nadie exacto: la solución al final ──
    cmd('director:next_question'); await wait(300);
    d.emit('director:start_timer'); await wait(200);
    send(0, [[0, '+', 1]], true); send(1, [[0, '*', 1]], true); await wait(300);
    cmd('director:reveal_answer'); await wait(500);
    const cf2 = ds().cifras;
    check('Sin exacta: un paso más para la solución (calculada si no venía hecha)', cf2.total === cf2.groups.length + 1 && cf2.solution.length >= 1, cf2);
    d.emit('director:reveal_next_pair'); await wait(200);
    check('La solución no sale hasta destapar los grupos', P[0].sync.cifras.solution === null);
    d.emit('director:reveal_next_pair'); await wait(200);
    check('Destapados los grupos, se ve la solución', Array.isArray(P[0].sync.cifras.solution) && P[0].sync.cifras.revealStep === 1 + 0 + 1);
    const before = score(1);
    d.emit('director:reveal_next_pair'); await wait(200);
    check('Con la solución vista, suman (a 47 y 48: nada)', score(1) === before && ds().cifras.revealStep === ds().cifras.total);

    // ── Usar todas ──
    cmd('director:next_question'); await wait(300);
    d.emit('director:start_timer'); await wait(200);
    send(0, [[0, '*', 1]], true); await wait(200);
    check('«Usar todas»: sin usarlas todas no se puede enviar', !ds().answers[T[0]] || !ds().answers[T[0]].submitted);
    send(0, [[0, '*', 1], [2, '-', 3], [4, '-', 5]], true); await wait(200);
    check('«Usar todas»: usándolas todas, sí', ds().answers[T[0]] && ds().answers[T[0]].submitted);

    // ── Volver a una ya jugada ──
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    check('Volver a una pregunta ya jugada: revelada y sin volver a puntuar', ds().phase === 'answer_revealed' && ds().cifras.revealStep === ds().cifras.total && score(0) === pts[T[0]]);

    // ── Excel ──
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['t'], [], ['h'],
        ['C1', 345, '1, 3 7 9 25 100', '', 'no', '', 300],
        ['C1', '', '', 'dificil'],
        ['C1', '', '', 'facil', 'si', 45],
        ['C2', 12, '5'],
    ]), 'Cifras');
    const gx = (await api('/games', { method: 'POST', body: { name: 'ExcelCifras' } })).data;
    const fx = new FormData(); fx.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'c.xlsx');
    const impX = await (await fetch(B + `/api/games/${gx.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } })).json();
    const tx = (await api(`/games/${gx.id}`)).data;
    const c1 = tx.rounds.find(x => x.name === 'C1');
    const [qa, qb, qc] = c1.questions.map(q => q.content);
    check('Excel: números separados por espacio o coma, con solución calculada', qa.target === 345 && qa.numbers.join() === '1,3,7,9,25,100' && qa.solution.length > 0 && c1.questions[0].config.points === 300, qa);
    check('Excel: con solo el nivel, el programa se los inventa', qb.numbers.length === 6 && qb.target >= 101 && qb.level === 'dificil' && qb.solution[qb.solution.length - 1].r === qb.target && qc.numbers.length === 4 && qc.useAll === true && c1.questions[2].config.time === 45, [qb, qc]);
    check('Excel: ronda de Cifras con 60 s por defecto', c1.type === 'cifras' && c1.config.time === 60);
    check('Excel: un solo número = pregunta incompleta', impX.incomplete.length === 1 && impX.incomplete[0].missing.includes('numbers'), impX.incomplete);
    const ex = XLSX.read(Buffer.from(await (await fetch(B + `/api/games/${gx.id}/export-excel`, { headers: { cookie } })).arrayBuffer()));
    const rowsEx = XLSX.utils.sheet_to_json(ex.Sheets['Cifras'], { header: 1 }).slice(3);
    check('Exportar: la hoja Cifras vuelve a tener objetivo, números, nivel y «usar todas»', rowsEx.length === 4 && rowsEx[0][1] === 345 && rowsEx[0][2] === '1 3 7 9 25 100' && rowsEx[1][3] === 'dificil' && rowsEx[2][4] === 'si', rowsEx.slice(0, 3));
    const tpl = Buffer.from(await (await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } })).arrayBuffer());
    const wt = XLSX.read(tpl);
    check('La plantilla con ejemplos trae la hoja Cifras', !!wt.Sheets['Cifras']);

    server.kill();
    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    process.exit(ok === results.length ? 0 : 1);
})().catch(async (e) => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
