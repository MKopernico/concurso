// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-loteD-recuperar.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Lote D: pasar un equipo a otro iPad con el código de un solo uso del coordinador (puntos y
// bonos se conservan; el iPad viejo se desconecta; códigos falsos, caducados o repetidos no valen).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3208;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-loteD3');
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
    const g = (await api('/games', { method: 'POST', body: { name: 'Recuperar', status: 'published' } })).data;
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

    const getCode = (teamId) => new Promise(res => { d.once('director:recovery_code', res); d.emit('director:recovery_code', { teamId }); });
    d.emit('director:add_points', { teamId: T[0], points: 120 }); await wait(150);
    d.emit('admin_gestionar_bono', { equipoId: T[0], accion: 'add', tipo: 'freeze' }); await wait(150);
    const rc = await getCode(T[0]);
    check('El coordinador recibe un código de 6 caracteres y el pase del juego', /^[A-Z2-9]{6}$/.test(rc.code) && rc.pass === pass && rc.team === 'Equipo 0', rc);
    // iPad nuevo
    const nu = io(B, { query: { gameId: g.id, deviceId: 'nuevo', pass }, transports: ['websocket'], forceNew: true });
    nu.sync = null; nu.on('game:player_sync', s => { nu.sync = s; });
    await connected(nu);
    let oldGone = false; P[0].on('disconnect', () => { oldGone = true; });
    const bad = await new Promise(res => { nu.once('recover_result', res); nu.emit('player:recover_team', { code: 'ZZZZZZ', deviceId: 'nuevo' }); });
    check('Un código falso no vale', bad.ok === false, bad);
    const login = new Promise(res => nu.once('login_success', res));
    const ok = await new Promise(res => { nu.once('recover_result', res); nu.emit('player:recover_team', { code: rc.code.toLowerCase(), deviceId: 'nuevo' }); });
    const lg = await login; await wait(400);
    check('Con el código bueno el iPad nuevo pasa a ser el equipo', ok.ok === true && lg.miEquipo.id === T[0], { ok, id: lg.miEquipo.id });
    check('Conserva puntos y bonos', d.state.director.scores[T[0]] === 120 && (lg.miEquipo.bonos || []).includes('freeze'), { pts: d.state.director.scores[T[0]], bonos: lg.miEquipo.bonos });
    check('El iPad viejo queda desconectado', oldGone === true);
    const again = await new Promise(res => { const o = io(B, { query: { gameId: g.id, deviceId: 'otro', pass }, transports: ['websocket'], forceNew: true }); o.once('connect', () => { o.once('recover_result', r => { o.close(); res(r); }); o.emit('player:recover_team', { code: rc.code, deviceId: 'otro' }); }); });
    check('El código no se puede usar dos veces', again.ok === false, again);
    // El iPad nuevo juega como el equipo
    nu.emit('player:reconnect', { deviceId: 'nuevo' });
    const re = await new Promise(res => { nu.once('login_success', d2 => res(d2)); setTimeout(() => res(null), 1500); });
    check('Al recargar, el iPad nuevo sigue siendo el equipo', re && re.miEquipo.id === T[0]);
    // El viejo, al volver, ya no tiene equipo
    const old2 = io(B, { query: { gameId: g.id, deviceId: 'a0', pass }, transports: ['websocket'], forceNew: true });
    const oldRes = await new Promise(res => { old2.once('connect', () => { old2.once('reconnect_failed', r => res(r)); old2.once('login_success', () => res({ reason: 'sigue_siendo_equipo' })); old2.emit('player:reconnect', { deviceId: 'a0' }); }); setTimeout(() => res(null), 1500); });
    check('El iPad viejo ya no es el equipo', oldRes && oldRes.reason === 'no_team', oldRes);
    old2.close();
    // Un iPad que ya es otro equipo no puede recuperar
    const rc1 = await getCode(T[0]);
    const clash = await new Promise(res => { P[1].once('recover_result', res); P[1].emit('player:recover_team', { code: rc1.code, deviceId: 'a1' }); });
    check('Un iPad que ya es otro equipo no puede quedárselo', clash.ok === false && /ya es el equipo/.test(clash.error), clash);
    const L = await new Promise(res => { d.once('director:log', res); d.emit('director:get_log'); });
    check('Queda en el registro', L.log.some(e => e.action === 'recovered' && e.team === 'Equipo 0'));
    nu.close();
    [d, ...P].forEach(s => s.close());
    server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
