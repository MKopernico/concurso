// Ejecutar desde la carpeta del proyecto:  node tools/tests/chaos-test.js [minutos=10] [iPads=30]
// Arranca su propio servidor (puerto 3420) con una base de datos temporal (no toca tus datos).
// Prueba de red caótica: N iPads que se desconectan y reconectan al azar todo el rato (también a
// mitad de pregunta y justo al responder o pulsar), un tercio con retraso artificial, cortes de
// WiFi de media sala y conexiones "zombi" que se quedan colgadas. Al final comprueba que ningún
// equipo pierde ni duplica puntos, que nadie se queda sin equipo y que el servidor no registra errores.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const C = require('./sim-common');
const { wait, now, rnd, pick, chance, stats, fmtStats, until } = C;

const MINUTES = Number(process.argv[2]) || 10;
const N = Number(process.argv[3]) || 30;
const ORDER = ['multirespuesta', 'pulsador', 'precio', 'ruleta', 'boom', 'imagen', 'identidad', 'cancion', 'imagen_fija', 'karaoke'];

const report = [];
function check(name, ok, info) { report.push({ name, ok: !!ok, info }); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); }
const hhmm = () => new Date().toTimeString().slice(0, 8);
let srv;

(async () => {
    console.log(`\n══════ Prueba de red caótica: ${MINUTES} min · ${N} iPads ══════`);
    srv = new C.TestServer(3420, 'chaos');
    await srv.start();
    await srv.login();
    const game = await C.buildGame(srv, 'Caos', '7777');
    const gid = game.g.id;
    const d = C.makeDirector(srv, gid);
    await until(() => d.state, 10000);
    const scr = io(srv.B, { query: { gameId: gid }, transports: ['websocket'], forceNew: true });
    scr.on('connect', () => scr.emit('screen:join'));
    const pass = (await srv.api(`/games/${gid}/join`, { method: 'POST', body: { code: '7777' } })).data.pass;

    const CHAOS = { midQuestion: 0.12, onAnswer: 0.15, onBuzz: 0.15, offline: [300, 6000] };
    const ipads = Array.from({ length: N }, (_, i) => new C.Ipad(srv, gid, pass, i, {
        oracle: game.contentOf, chaos: CHAOS, lag: i % 3 === 0 ? rnd(80, 600) : 0, answerDelay: [200, 5000],
    }));
    const slow = ipads.filter(p => p.lag);
    console.log(`${slow.length} iPads con retraso artificial (${Math.min(...slow.map(p => p.lag))}-${Math.max(...slow.map(p => p.lag))} ms por mensaje, en cada sentido)`);

    // ── Entrada con cortes: algunos iPads se caen justo después de conectar / pedir equipo
    ipads.forEach(p => { p.connect(); if (chance(0.25)) setTimeout(() => p.drop(pick(['clean', 'drop', 'zombie']), rnd(300, 3000)), rnd(0, 400)); });
    const allIn = await until(() => ipads.every(p => p.teamId), 60000);
    check(`${N} iPads consiguen equipo aunque se corte la conexión al registrarse`, allIn, `${ipads.filter(p => p.teamId).length}/${N}`);
    await wait(1500); await d.fresh();
    check('se crean exactamente N equipos (ningún iPad duplicado al registrarse)', d.state.equipos.length === N, `${d.state.equipos.length} equipos`);

    // ── Verificación de respuestas y pulsaciones perdidas, pregunta a pregunta
    const loss = { timing: { checked: 0, respected: 0, capped: 0, early: [], samples: [] }, answers: { sent: 0, recorded: 0, recovered: 0, cutJustAfter: 0, cutNear: 0, late: 0, queuedNotSent: 0, queuedFlushed: 0, unexplained: [] }, buzz: { sent: 0, inQueue: 0, cut: 0, late: 0, unexplained: [] }, phantom: [] };
    const near = (sock, at) => sock && sock._endedAt && sock._endedAt - at < 3000;
    function onClosed(info) {
        const byTeam = new Map(ipads.map(p => [p.firstTeamId, p]));
        if (info.recorded) {
            for (const t of Object.keys(info.recorded)) {
                const p = byTeam.get(t); const l = p && p.log[info.key];
                if (!l || !(l.result || l.flushed || l.provisionalOnly || l.scheduled)) loss.phantom.push({ t, key: info.key });
            }
            for (const p of ipads) {
                const l = p.log[info.key]; if (!l) continue;
                const got = !!info.recorded[p.firstTeamId];
                if (l.provisionalOnly) continue;
                if (l.result === 'queued') { if (l.flushed) loss.answers.queuedFlushed++; else { loss.answers.queuedNotSent++; continue; } }
                if (!(l.result === 'sent' || l.flushed)) continue;
                loss.answers.sent++;
                if (got) {
                    loss.answers.recorded++;
                    if (l.resent) loss.answers.recovered++;
                    if ((l.resent || l.flushed) && l.pressAt) {
                        // Reenviada o enviada al volver: debe contar con el momento en que se pulsó
                        // (el servidor y la prueba comparten reloj). Más tarde solo si se aplicó el tope de 10 s.
                        const ts = info.recorded[p.firstTeamId].timestamp;
                        // El viaje del propio mensaje (retraso de red) cuenta, igual que en una respuesta normal
                        const diff = ts - l.pressAt, transit = p.lag * 1.5 + 150;
                        loss.timing.checked++;
                        loss.timing.samples.push({ lag: p.lag, diff });
                        if (diff >= -150 && diff <= transit) loss.timing.respected++;
                        else if (diff > transit) loss.timing.capped++;
                        else loss.timing.early.push({ ipad: p.i, key: info.key, diffMs: diff });
                    }
                    continue;
                }
                if (l.droppedRightAfter) loss.answers.cutJustAfter++;
                else if (near(l.sock, l.sentAt)) loss.answers.cutNear++;
                else if (l.sentAt + p.lag * 1.5 + 500 > info.closeAt) loss.answers.late++;
                else loss.answers.unexplained.push({ ipad: p.i, team: p.firstTeamId, type: info.type, key: info.key, lag: p.lag, sentAgoMs: info.closeAt - l.sentAt });
            }
        } else if (info.queue) {
            for (const p of ipads) {
                const l = p.log[info.key]; if (!l || l.buzz !== 'sent') continue;
                loss.buzz.sent++;
                if (info.queue.includes(p.firstTeamId)) { loss.buzz.inQueue++; continue; }
                if (l.buzzDropped || near(l.buzzSock, l.buzzAt)) loss.buzz.cut++;
                else if (l.buzzAt + p.lag * 1.5 + 400 > info.readAt) loss.buzz.late++;
                else loss.buzz.unexplained.push({ ipad: p.i, team: p.firstTeamId, type: info.type, key: info.key, lag: p.lag });
            }
        }
    }
    const coord = new C.Coordinator(srv, game, d, { waitAll: false, answerWindow: [6000, 9000], buzzWindow: [2500, 3500], onClosed, log: (m) => console.log(m) });

    // ── Caos de fondo: cortes sueltos al azar + cortes de WiFi de media sala
    let chaosOn = true, massDrops = 0, dirDrops = 0;
    const bg = setInterval(() => {
        if (!chaosOn) return;
        for (const p of ipads) if (chance(0.011)) p.drop(pick(['clean', 'drop', 'drop', 'zombie']));
    }, 500);
    const mass = setInterval(() => {
        if (!chaosOn) return;
        massDrops++;
        const victims = ipads.filter(() => chance(0.5));
        console.log(`[${hhmm()}] corte de WiFi: ${victims.length} iPads a la vez`);
        victims.forEach(p => p.drop('drop', rnd(1000, 8000)));
    }, 120000);

    const t0 = Date.now(), end = t0 + MINUTES * 60000;
    let loops = 0, fatal = null, lastDirDrop = t0;
    const progress = setInterval(() => {
        const drops = ipads.reduce((a, p) => a + p.ev.drops, 0);
        console.log(`[${hhmm()}] min ${Math.round((Date.now() - t0) / 60000)} · ${coord.questions} preguntas · ${drops} cortes provocados · ${ipads.filter(p => p.sock && p.sock.connected).length}/${N} conectados ahora · diferencias de marcador ${coord.mismatches.length}`);
    }, 60000);
    try {
        while (Date.now() < end) {
            loops++;
            for (const type of ORDER) {
                if (Date.now() >= end) break;
                const qs = await game.refreshQuestions(type, type === 'karaoke' ? 1 : 2, type === 'multirespuesta' ? 0 : -1);
                await coord.playRound(type, qs);
                if (Date.now() - lastDirDrop > 150000) {
                    // También se le cae la conexión a la tablet del coordinador (entre rondas)
                    lastDirDrop = Date.now(); dirDrops++;
                    d.io.engine.close();
                    await until(() => d.connected, 20000); await d.fresh(300);
                }
            }
        }
    } catch (e) { fatal = e; console.log('ERROR en la partida: ' + (e.stack || e)); }
    chaosOn = false;
    clearInterval(bg); clearInterval(mass); clearInterval(progress);

    // ── Fin del caos: todos vuelven y se comprueba el estado
    console.log(`\n── Fin del caos tras ${Math.round((Date.now() - t0) / 60000)} min · ${coord.questions} preguntas · esperando a que vuelvan todos ──`);
    check('la partida se jugó entera sin bloquearse', !fatal, fatal ? String(fatal.message) : undefined);
    const back = await until(() => ipads.every(p => p.sock && p.sock.connected && p.loggedSock === p.sock), 90000, 100);
    check('todos los iPads vuelven a estar dentro con su equipo', back, `${ipads.filter(p => p.sock && p.sock.connected && p.loggedSock === p.sock).length}/${N}`);
    // Las conexiones zombi tardan hasta ~45 s en caducar en el servidor
    const expectSockets = N + 2;
    let s;
    const t1 = now();
    while (true) { s = await srv.sample(); if (s.sockets.sockets <= expectSockets || now() - t1 > 75000) break; await wait(2000); }
    check('el servidor limpia las conexiones caídas y zombis', s.sockets.sockets === expectSockets, `${s.sockets.sockets} conexiones (esperadas ${expectSockets}) tras ${Math.round((now() - t1) / 1000)} s`);
    const g = s.games[gid];
    const deviceIds = ipads.map(p => p.deviceId);
    const dbDev = (g.dbTeams || []).map(t => t.device_id);
    check('en la base de datos hay exactamente un equipo por iPad', g.dbTeams.length === N && deviceIds.every(dv => dbDev.filter(x => x === dv).length === 1), `${g.dbTeams.length} equipos en BD`);
    check('en memoria hay exactamente un equipo por iPad', g.equipos === N && deviceIds.every(dv => g.teams.filter(t => t.deviceId === dv).length === 1), `${g.equipos} equipos`);
    const liveIds = new Set(ipads.map(p => p.sock && p.sock.id));
    const wrongLink = g.teams.filter(t => !t.ocupado || !liveIds.has(t.socketId));
    check('cada equipo está ligado a la conexión actual de su iPad (nadie se queda sin equipo)', wrongLink.length === 0, wrongLink.length ? `${wrongLink.length} equipos mal ligados` : `${g.ocupados}/${N} ocupados`);
    check('ningún iPad cambió de equipo al reconectar', ipads.every(p => !p.ev.teamChanged && p.teamId === p.firstTeamId));
    const fails = ipads.flatMap(p => p.ev.reconnectFailed.map(r => ({ i: p.i, r }))), regErr = ipads.flatMap(p => p.ev.registerError);
    check('ninguna reconexión fue rechazada', fails.length === 0 && regErr.length === 0, fails.length || regErr.length ? { fails: fails.slice(0, 5), regErr: regErr.slice(0, 3) } : undefined);

    await coord.fresh(300);
    const server = coord.scores();
    const ids = d.state.equipos.map(e => e.id);
    const diff = ids.filter(t => (server[t] || 0) !== (coord.ledger[t] || 0)).map(t => ({ t, servidor: server[t] || 0, esperado: coord.ledger[t] || 0 }));
    check('ningún equipo pierde ni duplica puntos: el marcador final cuadra', diff.length === 0, diff.length ? diff.slice(0, 5) : `${ids.length} equipos, total ${ids.reduce((a, t) => a + (server[t] || 0), 0)} puntos`);
    check('cada pregunta sumó exactamente lo esperado', coord.mismatches.length === 0, coord.mismatches.length ? coord.mismatches.slice(0, 5) : `${coord.questions} preguntas revisadas`);
    await wait(2600);
    const sP = await srv.sample();
    const ps = (sP.games[gid] || {}).persistedScores || {};
    check('el marcador guardado en la base de datos coincide con el de memoria', ids.every(t => (ps[t] || 0) === (server[t] || 0)));
    check('ningún equipo aparece dos veces en la cola del pulsador', ipads.every(p => !p.ev.dupQueue));
    check('ninguna respuesta "fantasma" (registrada sin que el iPad la enviara)', loss.phantom.length === 0, loss.phantom.slice(0, 3));
    check('no se pierde ninguna respuesta enviada con la conexión estable', loss.answers.unexplained.length === 0, loss.answers.unexplained.length ? loss.answers.unexplained.slice(0, 5) : undefined);
    const TM = loss.timing;
    check('las respuestas reenviadas cuentan con el momento en que se pulsaron (nunca antes)', TM.early.length === 0 && TM.checked > 0 && TM.respected >= TM.checked * 0.9, `${TM.respected}/${TM.checked} con su hora de pulsación (más el viaje del mensaje) · ${TM.capped} limitadas por el tope de 10 s${TM.early.length ? ' · ANTES de pulsar: ' + JSON.stringify(TM.early.slice(0, 3)) : ''}`);
    check('no se pierde ninguna pulsación enviada con la conexión estable', loss.buzz.unexplained.length === 0, loss.buzz.unexplained.length ? loss.buzz.unexplained.slice(0, 5) : undefined);
    check('el servidor no registró errores', sP.errors === 0 && srv.stderr.length === 0, sP.errors ? sP.errSamples.slice(0, 3) : (srv.stderr.length ? srv.stderr.slice(0, 3) : undefined));
    check('el coordinador no recibió avisos de error', d.errors.length === 0, d.errors.slice(0, 5));

    // ── Resumen en cifras
    const sum = (k) => ipads.reduce((a, p) => a + (p.ev[k] || 0), 0);
    const A = loss.answers, Bz = loss.buzz;
    console.log(`\nCortes provocados: ${sum('drops')} (limpios ${sum('drop_clean')}, caída de red ${sum('drop_drop')}, zombis ${sum('drop_zombie')}) · cortes de WiFi de media sala: ${massDrops} · cortes del coordinador: ${dirDrops}`);
    console.log(`Reconexiones con éxito: ${sum('logins') - N} · respuestas guardadas sin conexión y enviadas al volver: ${A.queuedFlushed} · perdidas en el corte y recuperadas por reenvío automático: ${A.recovered}`);
    console.log(`Respuestas enviadas: ${A.sent} · registradas ${A.recorded} · perdidas por cortarse justo al enviar ${A.cutJustAfter} · por un corte en los 3 s siguientes ${A.cutNear} · llegaron tarde ${A.late} · guardadas pero la pregunta cerró antes de volver ${A.queuedNotSent} · inexplicables ${A.unexplained.length}`);
    console.log(`Pulsaciones enviadas: ${Bz.sent} · en la cola ${Bz.inQueue} · perdidas por corte ${Bz.cut} · tarde ${Bz.late} · inexplicables ${Bz.unexplained.length}`);
    const lat = (arr, k) => fmtStats(stats(arr.flatMap(p => p.lat[k])));
    console.log(`Latencia respuesta · red normal: ${lat(ipads.filter(p => !p.lag), 'answer')} · con retraso: ${lat(slow, 'answer')}`);
    console.log(`Latencia pulsador · red normal: ${lat(ipads.filter(p => !p.lag), 'buzz')} · con retraso: ${lat(slow, 'buzz')}`);

    const outDir = path.join(C.REPO, 'tmp', 'pruebas');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `caos-${MINUTES}min-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
    fs.writeFileSync(out, JSON.stringify({ minutes: MINUTES, ipads: N, questions: coord.questions, report, loss, mismatches: coord.mismatches, ipadEvents: ipads.map(p => ({ i: p.i, lag: p.lag, ...p.ev })), errSamples: sP.errSamples, stderr: srv.stderr }, null, 1));
    console.log('Datos detallados: ' + path.relative(C.REPO, out));

    [d, scr].forEach(x => x.close());
    ipads.forEach(p => p.stop());
    srv.stop();
    const failed = report.filter(r => !r.ok).length;
    console.log(`\n${report.length - failed}/${report.length} comprobaciones superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (srv) srv.stop(); process.exit(1); });
