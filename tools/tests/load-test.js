// Ejecutar desde la carpeta del proyecto:  node tools/tests/load-test.js 50
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Prueba de carga: N iPads simulados contra un servidor propio (puerto 3400, BD temporal).
//   node load-test.js 30
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const N = Number(process.argv[2]) || 30;
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3400, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-load');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex'); // el servidor de prueba arranca con esta contraseña
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
let server, cookie = '';
const report = [];
function check(name, ok, info) { report.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); }
function stats(arr) { const a = arr.slice().sort((x, y) => x - y); const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))]; return `p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · máx ${a[a.length - 1]} ms`; }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('no arrancó');
}
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));
async function until(cond, timeoutMs = 15000) { const t0 = now(); while (!cond()) { if (now() - t0 > timeoutMs) return false; await wait(5); } return true; }

function makePlayer(gameId, pass, i) {
    const s = io(B, { query: { gameId, deviceId: 'load' + i, pass }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.i = i; s.bytes = 0; s.msgs = 0; s.syncBytes = []; s.last = {};
    s.onAny((ev, d) => {
        const len = JSON.stringify(d === undefined ? null : d).length;
        s.bytes += len; s.msgs++;
        if (ev === 'game:player_sync') s.syncBytes.push(len);
        s.last[ev] = now();
    });
    return s;
}

(async () => {
    console.log(`\n══════ Prueba de carga con ${N} iPads simulados ══════`);
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const g = (await api('/games', { method: 'POST', body: { name: 'Carga', status: 'published', access_code: '4321' } })).data;
    const rm = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Multi', type: 'multirespuesta', config: { time: 60, basePoints: 100, bonusMax: 0, penalty: 10 } } })).data;
    await api(`/rounds/${rm.id}/questions`, { method: 'POST', body: { content: { statement: '¿?', options: ['a', 'b', 'c', 'd'], correct: [0] } } });
    const rp = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'Pulsa', type: 'pulsador', config: { basePoints: 100 } } })).data;
    await api(`/rounds/${rp.id}/questions`, { method: 'POST', body: { content: { statement: 'P', answer: 'x' } } });
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', st => { d.state = st; }); d.on('connect', () => d.emit('director:join'));
    await connected(d); await until(() => d.state);
    const scr = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true });
    let scrBytes = 0; scr.onAny((ev, x) => { scrBytes += JSON.stringify(x === undefined ? null : x).length; });
    await connected(scr); scr.emit('screen:join');

    // ── 1. Entrada simultánea (código + registro)
    let t0 = now();
    const passes = await Promise.all(Array.from({ length: N }, () => api(`/games/${g.id}/join`, { method: 'POST', body: { code: '4321' } })));
    const okJoin = passes.filter(p => p.status === 200).length;
    check(`1. ${N} iPads validan el código a la vez (mismo NAT: mismo límite de intentos)`, okJoin === N, `${okJoin}/${N} con pase`);
    const pass = passes.find(p => p.status === 200).data.pass;
    const P = Array.from({ length: N }, (_, i) => makePlayer(g.id, pass, i));
    await Promise.all(P.map(connected));
    const loginT = [];
    await Promise.all(P.map(p => new Promise(res => { const ts = now(); p.once('login_success', (x) => { p.team = x.miEquipo.id; loginT.push(now() - ts); res(); }); p.emit('player:register_team', { name: 'Equipo ' + p.i, deviceId: 'load' + p.i }); })));
    check(`   todos registrados (${now() - t0} ms en total)`, d.state.equipos.length >= N || await until(() => d.state.equipos.length === N), stats(loginT));

    // ── 2. Multirespuesta: todos responden a la vez
    d.emit('director:launch_round', { roundId: rm.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:reveal_options'); await until(() => d.state.director.optionsRevealed);
    const before = { ...d.state.director.scores };
    t0 = now();
    P.forEach(p => p.emit('player:submit_answer', { answer: p.i % 4 }));
    const allIn = await until(() => d.state.director.answeredCount === N);
    const tAns = now() - t0;
    check(`2. ${N} respuestas simultáneas llegan todas al coordinador`, allIn, `${tAns} ms hasta ver ${d.state.director.answeredCount}/${N}`);
    t0 = now();
    const syncWait = P.map(p => new Promise(res => p.once('game:player_sync', () => res(now() - t0))));
    d.emit('director:reveal_answer');
    const revealT = await Promise.all(syncWait);
    await until(() => d.state.director.phase === 'answer_revealed');
    const scoresOk = P.every(p => (d.state.director.scores[p.team] || 0) - (before[p.team] || 0) === (p.i % 4 === 0 ? 100 : -10));
    check('   puntuación correcta para todos (+100 aciertan, −10 fallan)', scoresOk);
    check('   la revelación llega a todos los iPads', revealT.length === N, stats(revealT));

    // ── 3. Pulsador: todos pulsan a la vez
    d.emit('director:launch_round', { roundId: rp.id }); await wait(200);
    d.emit('director:launch_question', { idx: 0 }); await wait(200);
    d.emit('director:open_buzzer'); await until(() => d.state.pulsadorActivo);
    await wait(100);
    t0 = now();
    P.forEach(p => p.emit('pulsar_boton'));
    const allBuzz = await until(() => d.state.colaPulsador.length === N);
    const ids = d.state.colaPulsador.map(x => x.id);
    check(`3. ${N} pulsaciones simultáneas: cola completa y sin duplicados`, allBuzz && new Set(ids).size === N, `${now() - t0} ms · ${ids.length} en cola`);
    const elapsed = d.state.colaPulsador.map(x => x.elapsed);
    check('   la cola respeta el orden de llegada', elapsed.every((v, k) => k === 0 || v >= elapsed[k - 1]));
    d.emit('director:close_buzzer'); await wait(200);

    // ── 4. Todos congelan al mismo equipo a la vez
    const target = P[0].team;
    for (const p of P.slice(1)) d.emit('admin_gestionar_bono', { equipoId: p.team, accion: 'add', tipo: 'freeze' });
    await wait(200); d.emit('director:join');
    const bonosOk = await until(() => d.state.equipos.filter(e => (e.bonos || []).includes('freeze')).length === N - 1);
    if (!bonosOk) console.log('   (aviso: el coordinador no ve aún los bonos repartidos)');
    t0 = now();
    P.slice(1).forEach(p => p.emit('usar_bono', { tipo: 'freeze', targetId: target }));
    const notified = () => P.slice(1).filter(p => p.last['notificacion_bono'] >= t0).length;
    await until(() => notified() === N - 1, 8000);
    await wait(150); d.emit('director:join'); await wait(300); // estado fresco del servidor
    const tgt = d.state.equipos.find(e => e.id === target);
    const left = d.state.equipos.filter(e => (e.bonos || []).includes('freeze')).length;
    // El primero congela; los demás reciben "ya está congelado" y CONSERVAN su bono
    check(`4. ${N - 1} "congelar" a la vez contra el mismo equipo`, tgt.bloqueado && left === N - 2, `${now() - t0} ms · víctima congelada · 1 bono gastado, ${left} conservados`);

    // ── 5. Todos lanzan "congelar a todos" a la vez: solo uno puede ganar
    d.emit('director:unblock_all'); await until(() => d.state.equipos.every(e => !e.bloqueado));
    for (const p of P) d.emit('admin_gestionar_bono', { equipoId: p.team, accion: 'add', tipo: 'lock_all' });
    await wait(200); d.emit('director:join');
    await until(() => d.state.equipos.filter(e => (e.bonos || []).includes('lock_all')).length === N);
    P.forEach(p => p.emit('usar_bono', { tipo: 'lock_all' }));
    await wait(1500); d.emit('director:join'); await wait(300);
    const used = d.state.equipos.filter(e => !(e.bonos || []).includes('lock_all'));
    const free = d.state.equipos.filter(e => !e.bloqueado);
    check(`5. ${N} "congelar a todos" simultáneos: gana exactamente uno`, used.length === 1 && free.length === 1 && used[0].id === free[0].id, `usados ${used.length}, sin congelar ${free.length}`);
    d.emit('director:unblock_all');

    // ── 6. Cae la WiFi: todos se desconectan y vuelven a la vez
    const scoresBefore = { ...d.state.director.scores };
    P.forEach(p => p.disconnect());
    await wait(300);
    t0 = now();
    const P2 = Array.from({ length: N }, (_, i) => makePlayer(g.id, pass, i));
    await Promise.all(P2.map(connected));
    const backT = [];
    const back = await Promise.all(P2.map(p => new Promise(res => { const ts = now(); const to = setTimeout(() => res(null), 15000); p.once('login_success', (x) => { clearTimeout(to); backT.push(now() - ts); res(x.miEquipo.id); }); p.emit('player:reconnect', { deviceId: 'load' + p.i }); })));
    const sameTeams = back.every((id, i) => id === P[i].team);
    check(`6. reconexión masiva de ${N} iPads: todos recuperan su equipo`, sameTeams, `${now() - t0} ms en total · ${stats(backT)}`);
    check('   el marcador no cambia', JSON.stringify(scoresBefore) === JSON.stringify(d.state.director.scores));

    // ── Volumen de datos
    const syncs = P.flatMap(p => p.syncBytes);
    const avgSync = Math.round(syncs.reduce((a, b) => a + b, 0) / syncs.length);
    const totalPerIpad = Math.round(P.reduce((a, p) => a + p.bytes, 0) / N);
    const msgsPerIpad = Math.round(P.reduce((a, p) => a + p.msgs, 0) / N);
    console.log(`\nDatos: cada actualización del juego ≈ ${(avgSync / 1024).toFixed(1)} KB · cada iPad recibió ${msgsPerIpad} mensajes / ${(totalPerIpad / 1024).toFixed(0)} KB en toda la prueba · pantalla ${(scrBytes / 1024).toFixed(0)} KB`);
    const mem = await fetch(B + '/ping').then(() => null);

    [d, scr, ...P2].forEach(s => s.close());
    server.kill();
    const failed = report.filter(r => !r.ok).length;
    console.log(`${report.length - failed}/${report.length} comprobaciones superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
