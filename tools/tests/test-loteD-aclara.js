// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteD-aclara.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote D: «Imagen que se aclara». La nitidez avanza sola (o a mano), se congela al pulsar, un
// fallo la reanuda y el acierto vale más cuanto menos nítida estaba al pulsar.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3207;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteD2');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

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
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Aclara', status: 'published' } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rAc = await mk('Aclara', 'aclara', { basePoints: 100, penalty: 0 }, [{ image: '/uploads/images/prueba.png', answer: 'Torre Eiffel', effect: 'pixel', mode: 'auto', duration: 10 }, { image: '/uploads/images/prueba.png', answer: 'Big Ben', effect: 'blur', mode: 'manual', duration: 30 }]);
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

    d.emit('director:launch_round', { roundId: rAc.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(300);
    const c0 = P[0].sync.question.content;
    check('El iPad no recibe ni la imagen ni la respuesta', !c0.image && !c0.answer, c0);
    check('Empieza borrosa del todo y parada', P[0].sync.aclara && P[0].sync.aclara.level === 0 && P[0].sync.aclara.running === false, P[0].sync.aclara);
    d.emit('director:aclara_play'); await wait(300);
    check('«Aclarar» la pone en marcha y abre el pulsador', d.state.director.aclara.running === true && d.state.pulsadorActivo === true, d.state.director.aclara);
    await wait(1200);
    P[0].emit('pulsar_boton'); await wait(300);
    const e0 = d.state.colaPulsador[0];
    check('Al pulsar se congela la imagen', d.state.director.aclara.running === false && d.state.director.aclara.level > 0.1 && d.state.director.aclara.level < 0.25, d.state.director.aclara);
    check('La cola dice cuánto vale su acierto (menos cuanto más nítida)', e0 && e0.pts > 70 && e0.pts < 95 && e0.pts % 5 === 0, e0);
    const lvlStop = d.state.director.aclara.level;
    await wait(500);
    d.emit('director:join'); await wait(250);
    check('Mientras responde no avanza', Math.abs(d.state.director.aclara.level - lvlStop) < 0.001);
    cmd('director:mark_wrong', { teamId: T[0] }); await wait(300);
    check('Un fallo la vuelve a poner en marcha', d.state.director.aclara.running === true);
    await wait(1000);
    P[1].emit('pulsar_boton'); await wait(300);
    const e1 = d.state.colaPulsador[0];
    check('El segundo pulsa más tarde: vale menos', e1 && e1.pts < e0.pts, { antes: e0.pts, ahora: e1 && e1.pts });
    cmd('director:mark_correct', { teamId: T[1] }); await wait(400);
    check('El acierto suma lo que valía al pulsar', d.state.director.scores[T[1]] === e1.pts && P[1].sync.buzzerPoints === e1.pts, { score: d.state.director.scores[T[1]], pts: e1.pts });
    check('Al acertar se revela nítida', P[1].sync.phase === 'answer_revealed' && P[1].sync.aclara.level === 1 && P[1].sync.question.content.answer === 'Torre Eiffel');
    // Modo a mano
    cmd('director:next_question'); await wait(300);
    d.emit('director:aclara_set', { level: 0.5 }); await wait(300);
    check('A mano: la barra fija la nitidez y abre el pulsador', P[2].sync.aclara.level === 0.5 && P[2].sync.aclara.running === false && d.state.pulsadorActivo === true);
    P[2].emit('pulsar_boton'); await wait(300);
    check('A mano: a mitad de nitidez vale la mitad', d.state.colaPulsador[0] && d.state.colaPulsador[0].pts === 50, d.state.colaPulsador[0]);
    cmd('director:mark_wrong', { teamId: T[2] }); await wait(300);
    check('A mano: un fallo no la pone en marcha sola', d.state.director.aclara.running === false && d.state.director.aclara.level === 0.5);
    d.emit('director:aclara_set', { level: 0.95 }); await wait(250);
    P[0].emit('pulsar_boton'); await wait(300);
    check('Casi nítida vale el mínimo (20 %)', d.state.colaPulsador[0] && d.state.colaPulsador[0].pts === 20, d.state.colaPulsador[0]);
    // Excel: la plantilla trae la hoja nueva
    const tpl = await fetch(B + '/api/templates/importacion', { headers: { cookie } });
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const wb = XLSX.read(Buffer.from(await tpl.arrayBuffer()));
    check('La plantilla Excel incluye «Imagen se aclara»', wb.SheetNames.includes('Imagen se aclara'), wb.SheetNames);
    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
