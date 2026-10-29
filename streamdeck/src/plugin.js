// Complemento «GameShow» para Stream Deck. Lo arranca el programa Stream Deck con:
//   -port <puerto> -pluginUUID <id> -registerEvent <evento> -info <json>
// Habla con el programa por WebSocket (protocolo de Elgato) y con GameShow por socket.io (gameshow.js).
// Ajustes globales (los mismos para todas las teclas): { server, key }. Ajustes de cada tecla: los de su acción.

const WebSocket = require('ws');
const { GameShow } = require('./gameshow');
const { ACTIONS, typesOf, TYPE_LABELS } = require('./actions');
const { newer, short } = require('./version');

const args = {};
for (let i = 2; i < process.argv.length - 1; i++) if (process.argv[i].startsWith('-')) args[process.argv[i].slice(1)] = process.argv[i + 1];
const PROD = 'https://concurso-cf82.onrender.com';
/* global __PLUGIN_VERSION__ */
const VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0.0'; // lo pone build.js
let latest = null; // versión publicada en el servidor (⬇ Descargas)

// ¿Hay una versión nueva del complemento en el servidor? (al conectar y cada 6 h)
async function checkLatest() {
    if (!gs.server) return;
    try {
        const r = await fetch(gs.server + '/descargas/GameShow.streamDeckPlugin.json', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
        if (r.ok) { const j = await r.json(); latest = j && j.version ? String(j.version) : null; }
    } catch (e) {}
    gs.update = latest && newer(latest, VERSION) ? short(latest) : null;
    renderAll(); infoAll();
}
setInterval(checkLatest, 6 * 3600 * 1000).unref();

const gs = new GameShow();
const ctxs = new Map(); // context → { action, settings, controller, mem, last }
let sd = null, globals = {};

function send(o) { if (sd && sd.readyState === 1) sd.send(JSON.stringify(o)); }
function log(m) { send({ event: 'logMessage', payload: { message: '[GameShow] ' + m } }); }

function ctxFor(context) {
    const c = ctxs.get(context);
    const a = c && ACTIONS[c.action];
    if (!a) return null;
    return { gs, st: gs.st, rounds: gs.rounds, settings: Object.assign({}, a.defaults || {}, c.settings || {}), mem: c.mem, refresh: () => render(context, true) };
}

// Pinta una tecla o una rueda (solo manda lo que ha cambiado: el programa va más fluido)
function render(context, force) {
    const c = ctxs.get(context), a = c && ACTIONS[c.action];
    if (!a) return;
    const x = ctxFor(context);
    try {
        if (a.kind === 'dial') {
            const fb = a.render(x);
            const s = JSON.stringify(fb);
            if (force || s !== c.last) { c.last = s; send({ event: 'setFeedback', context, payload: fb }); }
        } else {
            const img = a.render(x);
            if (force || img !== c.last) { c.last = img; send({ event: 'setImage', context, payload: { image: img, target: 0 } }); }
        }
    } catch (e) { log('render ' + c.action + ': ' + e.message); }
}
let _allT = null;
function renderAll() {
    if (_allT) return;
    _allT = setTimeout(() => { _allT = null; for (const k of ctxs.keys()) render(k); }, 80);
}
gs.on('change', renderAll);
gs.on('tick', renderAll);

function ok(context, done) { if (done === false) send({ event: 'showAlert', context }); }

function onMessage(m) {
    const { event, context, action, payload } = m;
    switch (event) {
        case 'didReceiveGlobalSettings':
            globals = (payload && payload.settings) || {};
            gs.configure(globals.server || PROD, globals.key);
            checkLatest();
            break;
        case 'willAppear': {
            if (!ACTIONS[action]) return;
            ctxs.set(context, { action, settings: (payload && payload.settings) || {}, controller: payload && payload.controller, mem: {}, last: null });
            const a = ACTIONS[action];
            if (a.kind === 'dial') send({ event: 'setFeedbackLayout', context, payload: { layout: a.layout } });
            render(context, true);
            break;
        }
        case 'willDisappear': ctxs.delete(context); break;
        case 'didReceiveSettings': {
            const c = ctxs.get(context);
            if (c) { c.settings = (payload && payload.settings) || {}; c.mem = {}; render(context, true); }
            break;
        }
        case 'keyDown': {
            const a = ACTIONS[action], x = ctxFor(context);
            if (!a || !x || a.kind !== 'key') return;
            ok(context, a.key(x) !== false && gs.code === 'ok' ? undefined : false);
            break;
        }
        case 'dialRotate': {
            const a = ACTIONS[action], x = ctxFor(context);
            if (!a || !x || !a.rotate) return;
            const r = a.rotate(x, Number(payload && payload.ticks) || 0);
            if (r && typeof r === 'object') send({ event: 'setFeedback', context, payload: r }); // se ve al momento, sin esperar al servidor
            else if (r) render(context, true);
            break;
        }
        case 'dialDown': case 'touchTap': {
            const a = ACTIONS[action], x = ctxFor(context);
            if (!a || !x || !a.push) return;
            ok(context, a.push(x) !== false && gs.code === 'ok' ? undefined : false);
            break;
        }
        case 'propertyInspectorDidAppear': { const c = ctxs.get(context); if (c) c.pi = true; sendInfo(context); break; }
        case 'propertyInspectorDidDisappear': { const c = ctxs.get(context); if (c) c.pi = false; break; }
        case 'sendToPlugin':
            if (payload && payload.type === 'info') sendInfo(context);
            // «Comprobar conexión»: vuelve a conectar desde cero y, al poco, cuenta cómo ha ido
            if (payload && payload.type === 'check') { gs.reconnect(); checkLatest(); setTimeout(() => sendInfo(context, true), 2500); }
            break;
    }
}

// Al panel de ajustes: cómo va la conexión, las rondas y los tipos del juego emparejado
function sendInfo(context, checked) {
    send({ event: 'sendToPropertyInspector', context, payload: {
        type: 'info', status: gs.summary(), checked: !!checked,
        version: short(VERSION), update: gs.update || null,
        rounds: (gs.rounds || []).map((r, i) => ({ n: i + 1, name: r.name, type: r.type })),
        types: typesOf(gs.rounds).map(t => ({ id: t, name: TYPE_LABELS[t] || t })),
        allTypes: Object.keys(TYPE_LABELS).map(t => ({ id: t, name: TYPE_LABELS[t] })),
    } });
}
// Si cambia la conexión con un panel abierto, se le cuenta
function infoAll() { for (const k of ctxs.keys()) if (ctxs.get(k).pi) sendInfo(k); }
gs.on('change', infoAll);

function start() {
    sd = new WebSocket('ws://127.0.0.1:' + args.port);
    sd.on('open', () => {
        send({ event: args.registerEvent, uuid: args.pluginUUID });
        send({ event: 'getGlobalSettings', context: args.pluginUUID });
    });
    sd.on('message', (data) => { let m; try { m = JSON.parse(String(data)); } catch (e) { return; } try { onMessage(m); } catch (e) { log(e.stack || e.message); } });
    sd.on('close', () => { gs.close(); process.exit(0); });
    sd.on('error', () => {});
}
process.on('uncaughtException', (e) => { try { log('error: ' + (e.stack || e.message)); } catch (_) {} });

start();
