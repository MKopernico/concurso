// Sonda para las pruebas largas (soak-test.js, chaos-test.js). No se usa en producción.
// Se carga antes que el servidor:  node --expose-gc --require tools/tests/probe.js server.js
// Mide el proceso desde dentro (memoria, temporizadores, conexiones, retardo del bucle de eventos,
// errores registrados, tamaño del estado del juego) y lo envía al script de prueba por IPC.
// No cambia el comportamiento del servidor: solo observa.
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

// Guardar la instancia de Socket.io que crea server.js (para contar conexiones y salas)
const sio = require('socket.io');
let ioRef = null;
const OrigServer = sio.Server;
sio.Server = class ProbeServer extends OrigServer { constructor(...a) { super(...a); ioRef = this; } };

// Todo error que el servidor registra (handlers de socket, uncaughtException, persistencia…)
let errors = 0;
const errSamples = [];
const origError = console.error;
console.error = (...a) => {
    errors++;
    if (errSamples.length < 30) errSamples.push(a.map(x => (x && x.stack) || String(x)).join(' ').slice(0, 600));
    origError(...a);
};

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

function gameInfo() {
    const out = {};
    let mod;
    try { mod = require(path.join(process.cwd(), 'sockets', 'game.js')); } catch { return out; }
    let db = null;
    try { db = require(path.join(process.cwd(), 'db')).db; } catch {}
    for (const [gid, s] of mod.gameStates) {
        const ds = s.director;
        let persisted = null;
        if (db && s._sessionId) {
            try { const row = db.prepare('SELECT state FROM sessions WHERE id = ?').get(s._sessionId); persisted = row && row.state ? JSON.parse(row.state).scores : null; } catch {}
        }
        let dbTeams = null;
        if (db && s._sessionId) {
            try { dbTeams = db.prepare('SELECT id, device_id FROM teams WHERE session_id = ?').all(s._sessionId); } catch {}
        }
        out[gid] = {
            equipos: s.equipos.length,
            ocupados: s.equipos.filter(e => e.ocupado).length,
            teams: s.equipos.map(e => ({ id: e.id, deviceId: e.deviceId, socketId: e.socketId, ocupado: e.ocupado })),
            dbTeams,
            scores: { ...ds.scores },
            persistedScores: persisted,
            bonoLog: (ds.bonoLog || []).length,
            questionResults: Object.keys(ds.questionResults || {}).length,
            snapshotBytes: JSON.stringify({ scores: ds.scores, completedRounds: ds.completedRounds, bonoLog: ds.bonoLog, questionResults: ds.questionResults || {} }).length,
            directorStateBytes: JSON.stringify({ ...ds, questionResults: undefined }).length, // lo que viaja al coordinador
            timers: {
                question: !!s._timerHandle,
                preCountdown: !!s._preCountdownHandle,
                precio: !!s.precioTimeoutHandle,
            },
        };
    }
    return out;
}

function sample() {
    if (global.gc) { global.gc(); global.gc(); }
    const m = process.memoryUsage();
    const resources = {};
    for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] || 0) + 1;
    let sockets = null;
    if (ioRef) {
        let roomMembers = 0;
        for (const set of ioRef.sockets.adapter.rooms.values()) roomMembers += set.size;
        let listeners = 0;
        for (const s of ioRef.sockets.sockets.values()) for (const ev of s.eventNames()) listeners += s.listenerCount(ev);
        sockets = {
            engine: ioRef.engine.clientsCount,
            sockets: ioRef.sockets.sockets.size,
            rooms: ioRef.sockets.adapter.rooms.size,
            roomMembers,
            listeners,
        };
    }
    const ev = { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
    loop.reset();
    return {
        t: Date.now(),
        mem: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers },
        resources, sockets, eventLoop: ev,
        errors, errSamples: errSamples.slice(),
        games: gameInfo(),
    };
}

if (process.send) {
    process.on('message', (msg) => {
        if (msg && msg.type === 'sample') {
            try { process.send({ type: 'sample', id: msg.id, data: sample() }); }
            catch (e) { process.send({ type: 'sample', id: msg.id, error: String(e && e.stack || e) }); }
        }
    });
}
