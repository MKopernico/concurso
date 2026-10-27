// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-letras.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Letras: diccionario (plurales y femeninos sí, conjugaciones y nombres propios no; tildes y ñ),
// generador, letras visibles pero sin jugar hasta abrir, sin «la más larga» en iPads ni pantalla,
// borrador y reenvío, índices tramposos, reconexión, cierre → corrección con la marca del diccionario,
// marcar a mano, puntos proporcionales con rapidez y extra a la más larga, revelado de la más corta a
// la más larga (puntos al final), rectificar ya revelada, volver a una jugada, API del backoffice y Excel.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const APP = process.env.GAMESHOW_TEST_APP || REPO;
const PORT = 3233;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-letras');
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
// Índices de las letras para escribir una palabra con unas letras
function idxOf(letters, word) {
    const used = {};
    return Array.from(word.toUpperCase()).map(ch => { const i = letters.findIndex((l, k) => l === ch && !used[k]); used[i] = true; return i; });
}

(async () => {
    // ── Diccionario y motor (sin servidor) ──
    const D = require(path.join(REPO, 'letras-dict.js')); // en el kit va dentro de app/server.js: allí se prueba por la partida
    const L = require(path.join(REPO, 'public/shared/letras.js'));
    check('Diccionario cargado (más de 90.000 palabras)', D.size() > 90000, D.size());
    check('Plurales, femeninos e infinitivos sí', ['casas', 'abogada', 'abogadas', 'canciones', 'lapices', 'examenes', 'felices', 'comer'].every(w => D.has(w)));
    check('Conjugaciones, nombres propios e inventadas no', ['comian', 'cantabamos', 'madrid', 'xqzt'].every(w => !D.has(w)));
    check('Tildes: da igual escribirlas; se enseña con tilde', D.has('cancion') === 'canción' && D.has('CANCIÓN') === 'canción');
    check('La ñ es una letra distinta de la n', !!D.has('niño') && !D.has('nino'));
    check('Letras limpias de cualquier forma de escribirlas', L.cleanLetters('a, e  r t ñ').join('') === 'AERTÑ');
    const b = D.best(L.cleanLetters('AERTSOLMN'), 6);
    check('Mejor palabra con unas letras', b.len >= 8 && b.words.every(w => L.canForm(L.normWord(w), L.cleanLetters('AERTSOLMN'))), b);
    const gens = [6, 9, 12].map(n => D.generate(n));
    check('Generador: las letras pedidas y buena palabra posible', gens.every((g, i) => g.letters.length === [6, 9, 12][i] && g.best.len >= [5, 7, 10][i] && L.validLetters(g.letters)), gens.map(g => g.letters.join('') + ':' + g.best.len));

    // ── Partida ──
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Letras', status: 'published' } })).data;
    const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Letras', type: 'letras', config: { time: 60, points: 500, fastestExtra: true } } })).data;
    const LET = ['C', 'A', 'N', 'C', 'I', 'O', 'N', 'E', 'S'];
    await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: { letters: LET, best: D.best(LET, 6) } } });
    await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: { letters: ['M', 'E', 'S', 'A'] } } });
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
        const p = io(B, { query: { gameId: g.id, deviceId: 'lt' + i, pass }, transports: ['websocket'], forceNew: true });
        p.sync = null; p.on('game:player_sync', s => { p.sync = s; });
        await connected(p); p.emit('player:register_team', { name: 'Equipo ' + i, deviceId: 'lt' + i }); P.push(p);
        await wait(80);
    }
    await wait(600);
    const T = d.state.equipos.map(e => e.id);
    const ds = () => d.state.director;
    const score = (i) => ds().scores[T[i]] || 0;
    const send = (i, word, final) => P[i].emit(final ? 'player:letras_submit' : 'player:letras_draft', { idx: idxOf(LET, word) });

    d.emit('director:launch_round', { roundId: r.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const c0 = P[0].sync.question.content;
    check('Al lanzar: iPads y pantalla ven las letras', c0.letters.join('') === LET.join('') && scr.sync.question.content.letters.length === 9);
    check('Ni iPads ni pantalla reciben la más larga posible', c0.best === undefined && scr.sync.question.content.best === undefined);
    check('Tiempo de la ronda (60 s)', ds().timer.total === 60);
    send(0, 'cancion', true); await wait(200);
    check('Antes de abrir no se puede enviar', !ds().answers[T[0]]);

    d.emit('director:start_timer'); await wait(300);
    send(0, 'canciones', true); await wait(150);        // 9 letras, en el diccionario
    send(1, 'cesio', true); await wait(150);            // 5
    send(1, 'cocinas', true); await wait(150);          // reenvía: 7
    send(2, 'canon', false); await wait(150);           // solo borrador: 5
    send(3, 'cansion', true); await wait(150);          // 7, no existe
    check('Envíos: cuentan 3 (el borrador no)', ds().answeredCount === 3 && scr.sync.cifrasSent === 3);
    check('El reenvío sustituye al anterior', L.wordFrom(LET, ds().answers[T[1]].answer) === 'cocinas');
    P[3].emit('player:letras_submit', { idx: [0, 0, 1] }); P[3].emit('player:letras_submit', { idx: [0, 99] }); await wait(200);
    check('Índices repetidos o fuera de las letras no valen', L.wordFrom(LET, ds().answers[T[3]].answer) === 'cansion');
    const got = await new Promise(res => { P[2].once('game:your_letras', res); P[2].emit('player:register_team', { name: 'Equipo 2', deviceId: 'lt2' }); setTimeout(() => res(null), 1500); });
    check('Al reconectar, el iPad recupera su palabra', got && L.wordFrom(LET, got.idx) === 'canon' && got.sent === null, got);

    cmd('director:reveal_answer'); await wait(400);
    const Lt = ds().letras;
    check('Cerrar: empieza la corrección (sigue la pregunta) y el tiempo se para', ds().phase === 'question' && Lt.step === 'correcting' && !ds().timer.running && P[0].sync.letras.step === 'correcting');
    check('El borrador cuenta como enviado al final', ds().answers[T[2]].submitted && ds().answers[T[2]].late);
    check('Cada palabra llega marcada según el diccionario', Lt.marks.canciones === true && Lt.marks.cocinas === true && Lt.marks.canon === true && Lt.marks.cansion === false && Lt.inDict.canciones === 'canciones', Lt.marks);
    P[0].emit('player:letras_submit', { idx: idxOf(LET, 'cocinas') }); await wait(150);
    check('Cerrada, ya no se acepta nada', L.wordFrom(LET, ds().answers[T[0]].answer) === 'canciones');
    d.emit('director:start_timer'); await wait(150);
    check('Corrigiendo, el tiempo no se reanuda', !ds().timer.running);
    d.emit('director:letras_mark', { word: 'canon', ok: false }); await wait(200);
    check('El coordinador cambia una marca', ds().letras.marks.canon === false);
    d.emit('director:letras_mark', { word: 'inventada', ok: true }); await wait(150);
    check('Una palabra que nadie ha puesto no se puede marcar', !('inventada' in ds().letras.marks));

    cmd('director:reveal_answer'); await wait(400);
    const L2 = ds().letras;
    check('Revelar: por longitudes de menor a mayor y al final la más larga posible', ds().phase === 'answer_revealed' && L2.groups.map(x => x.len).join() === '5,7,9' && L2.total === 4, L2.groups);
    const pts = L2.points;
    check('Puntos: la más larga todo + extra; 7 de 9 proporcional; no válidas, nada', pts[T[0]] > 450 && pts[T[0]] <= 550 && pts[T[1]] > 180 && pts[T[1]] <= 390 && pts[T[2]] === 0 && pts[T[3]] === 0 && L2.winner === T[0], pts);
    check('Los puntos esperan al final', score(0) === 0);
    const lq = P[1].sync.lastQuestionScores;
    check('iPads: nada destapado ni puntos aún', lq[T[0]].pending && lq[T[0]].word === undefined);
    d.emit('director:reveal_next_pair'); await wait(250);
    const v1 = P[1].sync.letras;
    check('Paso 1: las de 5 letras, con equipos y si valen', v1.revealStep === 1 && v1.groups.length === 1 && v1.groups[0].len === 5 && v1.groups[0].words[0].w === 'canon' && v1.groups[0].words[0].ok === false && v1.groups[0].words[0].teams[0] === T[2]);
    check('La más larga posible no sale hasta el final', !v1.best && !scr.sync.letras.best);
    d.emit('director:reveal_next_pair'); d.emit('director:reveal_next_pair'); await wait(300);
    check('Paso 3: las de 9 (las de 7 en el iPad con su palabra y sin puntos)', P[1].sync.letras.groups.length === 3 && P[1].sync.lastQuestionScores[T[1]].word === 'cocinas' && P[1].sync.lastQuestionScores[T[1]].points === 0);
    d.emit('director:reveal_next_pair'); await wait(300);
    const vf = P[0].sync.letras;
    check('Último paso: la más larga posible, el ganador y los puntos', vf.best && vf.best.len === 9 && vf.winner === T[0] && score(0) === pts[T[0]] && score(1) === pts[T[1]] && P[0].sync.lastQuestionScores[T[0]].points === pts[T[0]]);
    // Rectificar: «cansion» no está, pero el coordinador la da por buena (7 letras)
    d.emit('director:letras_mark', { word: 'cansion', ok: true }); await wait(300);
    check('Rectificar ya revelada: suma la diferencia', score(3) > 0 && score(3) === ds().letras.points[T[3]] && score(0) === pts[T[0]]);
    d.emit('director:letras_mark', { word: 'cansion', ok: false }); await wait(300);
    check('…y deshacerlo la quita', score(3) === 0);

    // ── Sin respuestas: solo el paso de la más larga posible (calculada si no venía) ──
    cmd('director:next_question'); await wait(300);
    d.emit('director:start_timer'); await wait(200);
    cmd('director:reveal_answer'); await wait(200); cmd('director:reveal_answer'); await wait(300);
    check('Nadie responde: un único paso, con la más larga calculada al momento', ds().letras.total === 1 && ds().letras.best.len === 4 && ds().letras.best.words.includes('mesa'), ds().letras);

    // ── Volver a una ya jugada ──
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    check('Volver a una pregunta ya jugada: revelada y sin repuntuar', ds().phase === 'answer_revealed' && ds().letras.revealStep === ds().letras.total && score(0) === pts[T[0]]);

    // ── API del backoffice ──
    const gen = (await api('/letras/generate', { method: 'POST', body: { count: 10 } })).data;
    check('API: generar 10 letras con su mejor palabra', gen.letters.length === 10 && gen.best.len >= 8, gen);
    const chk = (await api('/letras/check', { method: 'POST', body: { letters: 'm e s a' } })).data;
    check('API: comprobar unas letras', chk.letters.join('') === 'MESA' && chk.best.len === 4, chk);
    check('API: pocas letras = error', (await api('/letras/check', { method: 'POST', body: { letters: 'ab' } })).status === 400);
    const anon = await fetch(B + '/api/letras/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"letters":"mesa"}' });
    check('API: sin sesión no se puede usar', anon.status === 401);

    // ── Excel ──
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['t'], [], ['h'],
        ['L1', 'a e r t s o l m n', '', 45, 300],
        ['L1', '', 7],
        ['L2', 'abc'],
    ]), 'Letras');
    const gx = (await api('/games', { method: 'POST', body: { name: 'ExcelLetras' } })).data;
    const fx = new FormData(); fx.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'l.xlsx');
    const impX = await (await fetch(B + `/api/games/${gx.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } })).json();
    const tx = (await api(`/games/${gx.id}`)).data;
    const r1 = tx.rounds.find(x => x.name === 'L1');
    const [qa, qb] = r1.questions.map(q => q.content);
    check('Excel: letras de cualquier forma, con la mejor calculada, tiempo y puntos', qa.letters.join('') === 'AERTSOLMN' && qa.best.len >= 8 && r1.questions[0].config.time === 45 && r1.questions[0].config.points === 300, qa);
    check('Excel: con solo cuántas, el programa las inventa', qb.letters.length === 7 && qb.best.len >= 5 && r1.type === 'letras', qb);
    check('Excel: 3 letras = pregunta incompleta', impX.incomplete.length === 1 && impX.incomplete[0].missing.includes('letters'), impX.incomplete);
    const ex = XLSX.read(Buffer.from(await (await fetch(B + `/api/games/${gx.id}/export-excel`, { headers: { cookie } })).arrayBuffer()));
    const rowsEx = XLSX.utils.sheet_to_json(ex.Sheets['Letras'], { header: 1 }).slice(3);
    check('Exportar: la hoja Letras vuelve con letras y cuántas', rowsEx.length === 3 && rowsEx[0][1] === 'A E R T S O L M N' && rowsEx[0][2] === 9, rowsEx.slice(0, 2));
    const wt = XLSX.read(Buffer.from(await (await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } })).arrayBuffer()));
    check('La plantilla con ejemplos trae la hoja Letras', !!wt.Sheets['Letras']);

    server.kill();
    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    process.exit(ok === results.length ? 0 : 1);
})().catch(async (e) => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
