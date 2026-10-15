// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteE-sinpantalla.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote E: modo sin pantalla. El juego arranca con lo que diga el backoffice, el coordinador lo
// cambia en directo, los iPads y la vista incrustada lo reciben y queda en el registro.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3209;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteE');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'SinPantalla', status: 'published', theme: { noScreen: true, audio: 'ipads' } } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rPul = await mk('Pulsa', 'pulsador', { basePoints: 100, penalty: 20 }, [{ statement: 'P1', answer: 'x' }]);
    const rMul = await mk('Multi', 'multirespuesta', { time: 30, basePoints: 100, bonusMax: 0 }, [{ statement: 'M', options: ['x', 'y'], correct: [1] }]);
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

    check('El juego arranca sin pantalla y con sonido en los iPads (backoffice)', P[0].sync.noScreen === true && P[0].sync.audioOn === 'ipads', { ns: P[0].sync.noScreen, au: P[0].sync.audioOn });
    // Vista de pantalla incrustada en un iPad
    const emb = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true });
    emb.sync = null; emb.on('game:player_sync', s => { emb.sync = s; });
    await connected(emb); emb.emit('screen:join', { embed: true }); await wait(400);
    check('La vista incrustada recibe el estado y el modo', emb.sync && emb.sync.noScreen === true && emb.sync.audioOn === 'ipads');
    check('La vista incrustada no cuenta como pantalla', !d.state.director.screensPreload || Object.keys(d.state.director.screensPreload).length === 0);
    d.emit('director:set_audio', { where: 'sala' }); await wait(300);
    check('El coordinador pasa el sonido al ordenador', P[0].sync.audioOn === 'sala' && emb.sync.audioOn === 'sala');
    d.emit('director:set_no_screen', { on: false }); await wait(300);
    check('El coordinador vuelve a la pantalla de sala', P[0].sync.noScreen === false && emb.sync.noScreen === false);
    d.emit('director:set_no_screen', { on: true }); d.emit('director:set_audio', { where: 'otra cosa' }); await wait(300);
    check('Un valor raro de sonido se queda en «ordenador»', P[0].sync.audioOn === 'sala' && P[0].sync.noScreen === true);
    const L = await new Promise(res => { d.once('director:log', res); d.emit('director:get_log'); });
    check('Los cambios quedan en el registro', L.log.filter(e => e.action === 'no_screen').length === 2 && L.log.some(e => e.action === 'audio' && e.where === 'sala'), L.log.map(e => e.action));
    // Una partida nueva vuelve a lo que diga el backoffice
    await api('/games/' + g.id + '/session', { method: 'POST', body: { nueva: true } }); await wait(500);
    d.emit('director:join'); await wait(300);
    check('Partida nueva: vuelve a lo del backoffice', d.state.director.noScreen === true && d.state.director.audioOn === 'ipads', { ns: d.state.director.noScreen, au: d.state.director.audioOn });
    // Un juego normal va con pantalla
    const g2 = (await api('/games', { method: 'POST', body: { name: 'ConPantalla', status: 'published' } })).data;
    await api('/games/' + g2.id + '/session', { method: 'POST', body: {} });
    const s2 = io(B, { query: { gameId: g2.id }, transports: ['websocket'], forceNew: true });
    s2.sync = null; s2.on('game:player_sync', s => { s2.sync = s; });
    await connected(s2); s2.emit('screen:join'); await wait(400);
    check('Un juego normal va con pantalla y sonido en el ordenador', s2.sync && s2.sync.noScreen === false && s2.sync.audioOn === 'sala');
    emb.close(); s2.close();
    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
