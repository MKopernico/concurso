// Ejecutar desde la carpeta del proyecto:  node tools/tests/soak-test.js [minutos=15] [iPads=30]
// Arranca su propio servidor (puerto 3410) con una base de datos temporal (no toca tus datos).
// Prueba de resistencia: una partida larga con N iPads y un coordinador que recorre en bucle las
// rondas de los 10 tipos (preguntas, respuestas, pulsador, bonos, premios, revelar, marcador…).
// Cada pocos minutos mide memoria, temporizadores, conexiones y latencias para ver si algo crece
// o se degrada con el tiempo; al final comprueba que el marcador cuadra con el calculado aparte.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const C = require('./sim-common');
const { wait, now, stats, fmtStats, MB, KB, until } = C;

const MINUTES = Number(process.argv[2]) || 15;
const N = Number(process.argv[3]) || 30;
const SAMPLE_MS = Math.max(60000, Math.round(MINUTES * 60000 / 24));
const ORDER = ['multirespuesta', 'pulsador', 'precio', 'ruleta', 'boom', 'imagen', 'identidad', 'cancion', 'imagen_fija', 'karaoke'];

const report = [];
function check(name, ok, info) { report.push({ name, ok: !!ok, info }); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); }
const hhmm = () => new Date().toTimeString().slice(0, 8);
const res = (s, k) => (s.resources && s.resources[k]) || 0;

function trend(samples, get) {
    const pts = samples.map(s => [(s.t - samples[0].t) / 3600000, get(s)]).filter(p => typeof p[1] === 'number');
    if (pts.length < 3) return null;
    const n = pts.length, third = Math.max(1, Math.floor(n / 3));
    const avg = (a) => a.reduce((x, p) => x + p[1], 0) / a.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const slope = sxx ? pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
    return { first: avg(pts.slice(0, third)), last: avg(pts.slice(-third)), min: Math.min(...pts.map(p => p[1])), max: Math.max(...pts.map(p => p[1])), perHour: slope };
}

(async () => {
    console.log(`\n══════ Prueba de resistencia: ${MINUTES} min · ${N} iPads · muestra cada ${Math.round(SAMPLE_MS / 1000)} s ══════`);
    const srv = new C.TestServer(3410, 'soak');
    await srv.start();
    await wait(1500);
    const baseline = await srv.sample();
    await srv.login();
    const game = await C.buildGame(srv, 'Resistencia', '5555');
    const gid = game.g.id;

    const d = C.makeDirector(srv, gid);
    await until(() => d.state, 10000);
    const scr = io(srv.B, { query: { gameId: gid }, transports: ['websocket'], forceNew: true });
    scr.on('connect', () => scr.emit('screen:join'));
    const pass = (await srv.api(`/games/${gid}/join`, { method: 'POST', body: { code: '5555' } })).data.pass;

    const ipads = Array.from({ length: N }, (_, i) => new C.Ipad(srv, gid, pass, i, { oracle: game.contentOf, useBonos: true }));
    ipads.forEach(p => p.connect());
    const allIn = await until(() => ipads.every(p => p.teamId), 30000);
    check(`${N} iPads entran y registran su equipo`, allIn, `${ipads.filter(p => p.teamId).length}/${N}`);
    await d.fresh();
    for (const e of d.state.equipos) d.state.director.scores[e.id] = d.state.director.scores[e.id] || 0;

    const coord = new C.Coordinator(srv, game, d, { extras: true, log: (m) => console.log(m) });
    const t0 = Date.now(), end = t0 + MINUTES * 60000;
    const samples = [];
    const cursor = { ans: ipads.map(() => 0), buzz: ipads.map(() => 0), rtt: 0, q: 0, msgs: 0 };
    async function takeSample() {
        const s = await srv.sample();
        const ans = [], buzz = [];
        ipads.forEach((p, i) => { ans.push(...p.lat.answer.slice(cursor.ans[i])); cursor.ans[i] = p.lat.answer.length; buzz.push(...p.lat.buzz.slice(cursor.buzz[i])); cursor.buzz[i] = p.lat.buzz.length; });
        const rtt = coord.rtt.slice(cursor.rtt); cursor.rtt = coord.rtt.length;
        const msgs = ipads.reduce((a, p) => a + p.msgs, 0);
        s.window = { ans: stats(ans), buzz: stats(buzz), rtt: stats(rtt), questions: coord.questions - cursor.q, msgsPerIpad: Math.round((msgs - cursor.msgs) / N), dirSync: d.syncSizes.length ? d.syncSizes[d.syncSizes.length - 1] : null };
        cursor.q = coord.questions; cursor.msgs = msgs;
        s.minute = Math.round((s.t - t0) / 60000);
        samples.push(s);
        const g = s.games[gid] || {};
        console.log(`[${hhmm()}] min ${String(s.minute).padStart(3)} · ${coord.questions} preguntas · heap ${MB(s.mem.heapUsed)} · rss ${MB(s.mem.rss)} · temporizadores ${res(s, 'Timeout')} · conexiones ${s.sockets.sockets} · resp p95 ${s.window.ans.p95} ms · pulsa p95 ${s.window.buzz.p95} ms · coord p95 ${s.window.rtt.p95} ms · bucle p99 ${s.eventLoop.p99.toFixed(1)} ms · estado guardado ${KB(g.snapshotBytes || 0)} · errores ${s.errors}`);
    }
    await takeSample();
    let sampling = false;
    const sampler = setInterval(async () => { if (sampling) return; sampling = true; try { await takeSample(); } catch (e) { console.log('  (muestra fallida: ' + e.message + ')'); } sampling = false; }, SAMPLE_MS);

    let loops = 0, fatal = null;
    try {
        while (Date.now() < end) {
            loops++;
            for (const type of ORDER) {
                if (Date.now() >= end) break;
                const n = type === 'karaoke' ? 1 : 2;
                const qs = await game.refreshQuestions(type, n, (type === 'multirespuesta' || type === 'pulsador') ? 0 : -1);
                await coord.playRound(type, qs);
            }
        }
    } catch (e) { fatal = e; console.log('ERROR en la partida: ' + (e.stack || e)); }
    clearInterval(sampler);
    while (sampling) await wait(100);
    await takeSample();

    // ── Comprobaciones finales
    console.log(`\n── Resultado tras ${Math.round((Date.now() - t0) / 60000)} min, ${loops} vueltas, ${coord.questions} preguntas ──`);
    check('la partida se jugó entera sin bloquearse', !fatal, fatal ? String(fatal.message) : undefined);
    await coord.fresh(300);
    const server = coord.scores();
    const ids = d.state.equipos.map(e => e.id);
    const diff = ids.filter(t => (server[t] || 0) !== (coord.ledger[t] || 0)).map(t => ({ t, servidor: server[t] || 0, esperado: coord.ledger[t] || 0 }));
    check('el marcador final cuadra con el calculado por la prueba (todos los equipos)', diff.length === 0 && ids.length === N, diff.length ? diff.slice(0, 5) : `${ids.length} equipos, total ${ids.reduce((a, t) => a + (server[t] || 0), 0)} puntos`);
    check('ninguna pregunta sumó distinto de lo esperado', coord.mismatches.length === 0, coord.mismatches.length ? coord.mismatches.slice(0, 5) : `${coord.questions} preguntas revisadas`);
    await wait(2600);
    const sPersist = await srv.sample();
    const ps = (sPersist.games[gid] || {}).persistedScores || {};
    check('el marcador guardado en la base de datos coincide con el de memoria', ids.every(t => (ps[t] || 0) === (server[t] || 0)));
    const lost = ipads.filter(p => p.ev.reconnectFailed.length || p.ev.registerError.length || p.ev.teamChanged || p.ev.dupQueue);
    check('ningún iPad perdió su equipo ni vio la cola del pulsador duplicada', lost.length === 0, lost.length ? lost.map(p => ({ i: p.i, ...p.ev })).slice(0, 3) : undefined);
    check('el servidor no registró errores', sPersist.errors === 0 && srv.stderr.length === 0, sPersist.errors ? sPersist.errSamples.slice(0, 3) : (srv.stderr.length ? srv.stderr.slice(0, 3) : undefined));
    check('el coordinador no recibió avisos de error', d.errors.length === 0, d.errors.slice(0, 5));

    // ── ¿Crece o se degrada algo con el tiempo?
    const run = samples.slice(1);
    const T = {
        heap: trend(run, s => s.mem.heapUsed / 1048576),
        rss: trend(run, s => s.mem.rss / 1048576),
        timeouts: trend(run, s => res(s, 'Timeout')),
        tcp: trend(run, s => res(s, 'TCPSocketWrap')),
        sockets: trend(run, s => s.sockets.sockets),
        listeners: trend(run, s => s.sockets.listeners),
        loopP99: trend(run, s => s.eventLoop.p99),
        ansP95: trend(run.filter(s => s.window.ans.n), s => s.window.ans.p95),
        buzzP95: trend(run.filter(s => s.window.buzz.n), s => s.window.buzz.p95),
        rttP95: trend(run.filter(s => s.window.rtt.n), s => s.window.rtt.p95),
        snapshotKB: trend(run, s => (s.games[gid] || {}).snapshotBytes / 1024),
        directorKB: trend(run, s => (s.games[gid] || {}).directorStateBytes / 1024),
    };
    const f = (x, u = '') => x == null ? '—' : (Math.round(x * 10) / 10) + u;
    console.log('\nEvolución (media del primer tercio → último tercio · ritmo por hora):');
    const row = (label, t, u) => t && console.log(`  ${label.padEnd(34)} ${f(t.first, u)} → ${f(t.last, u)}  (mín ${f(t.min, u)}, máx ${f(t.max, u)}, ${t.perHour >= 0 ? '+' : ''}${f(t.perHour, u)}/h)`);
    row('memoria usada (tras limpiar)', T.heap, ' MB'); row('memoria total del proceso', T.rss, ' MB');
    row('temporizadores activos', T.timeouts); row('conexiones TCP abiertas', T.tcp); row('conexiones Socket.io', T.sockets); row('escuchas de eventos', T.listeners);
    row('retardo del servidor (p99)', T.loopP99, ' ms'); row('latencia respuesta iPad (p95)', T.ansP95, ' ms'); row('latencia pulsador (p95)', T.buzzP95, ' ms'); row('latencia coordinador (p95)', T.rttP95, ' ms');
    row('estado guardado cada 2 s', T.snapshotKB, ' KB'); row('estado que recibe el coordinador', T.directorKB, ' KB');

    const grew = (t, rel, abs) => t && t.last - t.first > Math.max(abs, t.first * rel);
    check('las conexiones se mantienen estables (sin acumular)', T.sockets && T.sockets.max - T.sockets.min <= 1, T.sockets && `${T.sockets.min}–${T.sockets.max}`);
    check('los temporizadores no se acumulan', !grew(T.timeouts, 0.15, 5), T.timeouts && `${f(T.timeouts.first)} → ${f(T.timeouts.last)}`);
    check('las escuchas de eventos no se acumulan', !grew(T.listeners, 0.05, 20), T.listeners && `${f(T.listeners.first)} → ${f(T.listeners.last)}`);
    check('las latencias no empeoran con el tiempo', !grew(T.ansP95, 1, 50) && !grew(T.buzzP95, 1, 50) && !grew(T.rttP95, 1, 50), `resp ${f(T.ansP95 && T.ansP95.first)}→${f(T.ansP95 && T.ansP95.last)} ms · pulsa ${f(T.buzzP95 && T.buzzP95.first)}→${f(T.buzzP95 && T.buzzP95.last)} ms · coord ${f(T.rttP95 && T.rttP95.first)}→${f(T.rttP95 && T.rttP95.last)} ms`);
    const qGrowth = coord.questions ? ((T.snapshotKB ? T.snapshotKB.max : 0) * 1024 / coord.questions) : 0;
    check('la memoria no crece de forma descontrolada', !grew(T.heap, 0.5, 15), T.heap && `${f(T.heap.first, ' MB')} → ${f(T.heap.last, ' MB')} (${T.heap.perHour >= 0 ? '+' : ''}${f(T.heap.perHour, ' MB')}/h; el estado guardado crece ≈${Math.round(qGrowth)} bytes por pregunta jugada)`);

    // ── Al terminar, todo vuelve a como estaba al arrancar
    [d, scr].forEach(s => s.close());
    ipads.forEach(p => p.stop());
    await wait(6000);
    const sEnd = await srv.sample();
    check('al irse todos, no quedan conexiones abiertas', sEnd.sockets.sockets === 0 && sEnd.sockets.engine === 0, sEnd.sockets);
    check('al irse todos, los temporizadores vuelven a los del arranque', res(sEnd, 'Timeout') <= res(baseline, 'Timeout') + 2, `arranque ${res(baseline, 'Timeout')} · final ${res(sEnd, 'Timeout')} · juego: ${JSON.stringify((sEnd.games[gid] || {}).timers)}`);
    check('al irse todos, las conexiones TCP vuelven a las del arranque', res(sEnd, 'TCPSocketWrap') <= res(baseline, 'TCPSocketWrap') + 1, `arranque ${res(baseline, 'TCPSocketWrap')} · final ${res(sEnd, 'TCPSocketWrap')}`);

    const allAns = stats(ipads.flatMap(p => p.lat.answer)), allBuzz = stats(ipads.flatMap(p => p.lat.buzz));
    console.log(`\nLatencia total · respuesta: ${fmtStats(allAns)} · pulsador: ${fmtStats(allBuzz)} · coordinador: ${fmtStats(stats(coord.rtt))}`);
    console.log(`Memoria · arranque ${MB(baseline.mem.heapUsed)} (rss ${MB(baseline.mem.rss)}) · máx en partida ${MB(Math.max(...run.map(s => s.mem.heapUsed)))} (rss ${MB(Math.max(...run.map(s => s.mem.rss)))}) · al final sin nadie ${MB(sEnd.mem.heapUsed)}`);

    const outDir = path.join(C.REPO, 'tmp', 'pruebas');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `resistencia-${MINUTES}min-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
    fs.writeFileSync(out, JSON.stringify({ minutes: MINUTES, ipads: N, loops, questions: coord.questions, report, trends: T, baseline, samples: samples.map(s => ({ ...s, games: Object.fromEntries(Object.entries(s.games).map(([k, g]) => [k, { ...g, teams: undefined, dbTeams: undefined, scores: undefined, persistedScores: undefined }])) })), end: sEnd, mismatches: coord.mismatches }, null, 1));
    console.log('Datos detallados: ' + path.relative(C.REPO, out));

    srv.stop();
    const failed = report.filter(r => !r.ok).length;
    console.log(`\n${report.length - failed}/${report.length} comprobaciones superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
