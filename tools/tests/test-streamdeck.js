// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-streamdeck.js
// Monta el complemento de Stream Deck y lo arranca de verdad contra un «programa Stream Deck de
// mentira» (el mismo protocolo WebSocket de Elgato) y un servidor de GameShow con BD temporal.
// Comprueba: claves (se ven una vez, se guardan cifradas, se anulan), emparejar desde el
// coordinador, lo que enseñan las teclas y la franja del +, «Siguiente paso» de principio a fin,
// pulsador con el equipo que pulsó y Correcto, crono (tecla y rueda, también restar), rondas por
// número y rueda, sonido (música, volumen por tecla y rueda), pantalla de sala, seguridad (clave
// mala, otro juego, anulada) y que el archivo descargable está al día y bien formado.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const WebSocket = require(path.resolve(__dirname, '..', '..', 'node_modules', 'ws'));

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3251, SDPORT = 3252;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-streamdeck');
const PW = 'pruebas-' + crypto.randomBytes(6).toString('hex');
const P = 'com.kopernico.gameshow.';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, plugin = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(50); } return false; }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie: opts.noCookie ? '' : cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc && !opts.noCookie) cookie = sc.split(';')[0];
    const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch {}
    return { status: res.status, data };
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));
function director(gameId) {
    const d = io(B, { query: { gameId }, transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    d.decks = null; d.on('game:deck_list', l => { d.decks = l; });
    return d;
}

// ── Programa Stream Deck de mentira ──
const sd = { ws: null, msgs: [], images: new Map(), feedback: new Map(), alerts: [], globals: null, registered: false };
const decodeImg = (uri) => Buffer.from(String(uri).split(',')[1] || '', 'base64').toString('utf8');
const textOf = (ctx) => (decodeImg(sd.images.get(ctx) || '').match(/<text[^>]*>([^<]*)<\/text>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(' ').replace(/&amp;/g, '&');
function sdSend(o) { sd.ws.send(JSON.stringify(o)); }
const appear = (ctx, action, settings, controller) => sdSend({ event: 'willAppear', action: P + action, context: ctx, device: 'dev1', payload: { settings: settings || {}, controller: controller || 'Keypad', coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
const press = (ctx, action) => sdSend({ event: 'keyDown', action: P + action, context: ctx, device: 'dev1', payload: { settings: {}, coordinates: { column: 0, row: 0 } } });
const rotate = (ctx, action, ticks) => sdSend({ event: 'dialRotate', action: P + action, context: ctx, device: 'dev2', payload: { ticks, pressed: false, settings: {}, controller: 'Encoder', coordinates: { column: 0, row: 0 } } });
const dialPush = (ctx, action) => sdSend({ event: 'dialDown', action: P + action, context: ctx, device: 'dev2', payload: { settings: {}, controller: 'Encoder', coordinates: { column: 0, row: 0 } } });

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    // Montar el complemento (lo mismo que se descarga)
    const builder = require(path.join(REPO, 'tools', 'streamdeck', 'build.js'));
    const before = fs.existsSync(builder.DEST + '.json') ? JSON.parse(fs.readFileSync(builder.DEST + '.json', 'utf8')) : null;
    check('El complemento descargable está al día con el código (si falla: node tools/streamdeck/build.js)', before && before.hash === builder.sourcesHash(), before && before.hash);
    const built = await builder.build();
    const manifest = JSON.parse(fs.readFileSync(path.join(built.dir, 'manifest.json'), 'utf8'));
    const uuids = manifest.Actions.map(a => a.UUID);
    check('Manifiesto bien formado: código, Node 20, iconos, ajustes y acciones de teclas y de ruedas', manifest.UUID === 'com.kopernico.gameshow' && manifest.CodePath === 'bin/plugin.js' && manifest.Nodejs.Version === '20' &&
        fs.existsSync(path.join(built.dir, 'bin', 'plugin.js')) && fs.existsSync(path.join(built.dir, 'imgs', 'plugin.png')) && fs.existsSync(path.join(built.dir, 'pi', 'index.html')) &&
        manifest.Actions.every(a => fs.existsSync(path.join(built.dir, a.Icon + '.svg')) && a.States && a.States[0].Image) &&
        manifest.Actions.filter(a => a.Controllers[0] === 'Encoder').length === 6 && manifest.Actions.filter(a => a.Controllers[0] === 'Keypad').length >= 25 && new Set(uuids).size === uuids.length, { actions: uuids.length });
    {
        const yauzl = require(path.join(REPO, 'node_modules', 'yauzl'));
        const names = await new Promise((res, rej) => yauzl.open(built.dest, { lazyEntries: true }, (e, z) => { if (e) return rej(e); const n = []; z.on('entry', en => { n.push(en.fileName); z.readEntry(); }); z.on('end', () => res(n)); z.readEntry(); }));
        check('El archivo .streamDeckPlugin es un zip con la carpeta del complemento dentro', names.includes('com.kopernico.gameshow.sdPlugin/manifest.json') && names.includes('com.kopernico.gameshow.sdPlugin/bin/plugin.js'), names.length);
    }

    // «Siguiente paso» en los demás tipos (con estados como los del coordinador)
    {
        const { nextStep } = require(path.join(REPO, 'streamdeck', 'src', 'next-step.js'));
        const S = (dir, extra) => ({ director: Object.assign({ phase: 'question', currentRoundId: 'r1', currentQuestionIdx: 0, questions: [{ content: { subs: [1, 2], items: [1, 2, 3], pairs: [1, 2] }, config: {} }, { content: {}, config: {} }], completedRounds: [] }, dir), colaPulsador: [], pulsadorActivo: false, ...(extra || {}) });
        const ab = (step, phase) => nextStep(S({ currentRound: { type: 'abierta' }, abierta: { step, revealStep: 0 }, phase: phase || 'question' })).label;
        check('Respuesta abierta: enunciado → abrir → cerrar → revelar → ir revelando 1/2', ab('intro') === 'Mostrar enunciado' && ab('shown') === 'Abrir respuestas' && ab('open') === 'Cerrar respuestas' && ab('correcting') === 'Revelar' && ab('revealed', 'answer_revealed') === 'Ir revelando 1/2',
            [ab('intro'), ab('shown'), ab('open'), ab('correcting'), ab('revealed', 'answer_revealed')]);
        const boom = nextStep(S({ currentRound: { type: 'boom' }, phase: 'answer_revealed', boomStep: 1 }));
        const boomDone = nextStep(S({ currentRound: { type: 'boom' }, phase: 'answer_revealed', boomStep: 3 }));
        check('Boom: va revelando posiciones y, al acabar, siguiente pregunta', boom.ev === 'director:reveal_next_pair' && boom.label === 'Ir revelando 2/3' && boomDone.ev === 'director:next_question', [boom.label, boomDone.label]);
        const last = nextStep(S({ currentRound: { type: 'multirespuesta' }, phase: 'answer_revealed', currentQuestionIdx: 1 }));
        check('Última pregunta: «Terminar ronda»', last.ev === 'director:finish_round');
        const bono = nextStep(S({ currentRound: { type: 'multirespuesta' }, phase: 'answer_revealed', questions: [{ content: {}, config: { premio: { tipo: 'freeze' } } }, {}] }));
        check('Pregunta con bono: avisa de que el ganador se elige en el coordinador', bono.none && /coordinador/.test(bono.label));
        const lt = [nextStep(S({ currentRound: { type: 'letras' } })).label, nextStep(S({ currentRound: { type: 'letras' }, optionsRevealed: true })).label, nextStep(S({ currentRound: { type: 'letras' }, optionsRevealed: true, letras: { step: 'correcting' } })).label];
        check('Letras: empezar → cerrar → revelar', lt.join('|') === 'Empezar|Cerrar|Revelar', lt);
        const pic = nextStep(S({ currentRound: { type: 'pictionary' }, pictionary: { step: 'setup' } }));
        const kar = nextStep(S({ currentRound: { type: 'karaoke' } }));
        const wt = nextStep(S({ phase: 'waiting', resumePhase: 'question' }));
        check('Pictionary «Empezar a dibujar», karaoke en el coordinador, «Espera» vuelve a la prueba', pic.ev === 'director:pic_start' && kar.none && wt.ev === 'director:resume_question', [pic.label, kar.label, wt.label]);
    }

    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const dl = await fetch(B + '/descargas/GameShow.streamDeckPlugin');
    check('Se descarga desde el servidor (⬇ Descargas)', dl.ok && Number(dl.headers.get('content-length') || (await dl.arrayBuffer()).byteLength) > 10000);

    // ── Claves ──
    check('Sin sesión no se ven ni se crean claves', (await api('/deck/keys', { noCookie: true })).status === 401 && (await api('/deck/keys', { method: 'POST', noCookie: true, body: { name: 'x' } })).status === 401);
    const created = (await api('/deck/keys', { method: 'POST', body: { name: 'PC de sala' } })).data;
    const list0 = (await api('/deck/keys')).data;
    check('Crear clave: se enseña una vez; la lista no la vuelve a enseñar', /^gsd_[A-Za-z0-9_-]{30,}$/.test(created.key) && list0.items.length === 1 && list0.items[0].name === 'PC de sala' && !JSON.stringify(list0).includes(created.key) && list0.items[0].online === false, list0);
    {
        const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
        const dbf = fs.readdirSync(DATA, { recursive: true }).map(f => path.join(DATA, String(f))).find(f => /\.db$/.test(f));
        const row = new Database(dbf, { readonly: true }).prepare("SELECT value FROM settings WHERE key = 'deck'").get();
        check('La clave no se guarda en claro en la base de datos', row && !row.value.includes(created.key) && JSON.parse(row.value).keys[0].hash);
    }

    // ── Juego de prueba ──
    const fd = new FormData(); fd.append('file', new Blob([Buffer.alloc(2048, 7)], { type: 'audio/mpeg' }), 'Fondo.mp3');
    const bg = (await (await fetch(B + '/api/upload/audio', { method: 'POST', body: fd, headers: { cookie } })).json()).url;
    const g = (await api('/games', { method: 'POST', body: { name: 'Juego del Deck', status: 'published', theme: { music: [bg] } } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rMul = await mk('Preguntas', 'multirespuesta', { time: 30 }, [{ question: '¿2+2?', options: ['3', '4'], correct: [1] }, { question: '¿Capital?', options: ['Roma', 'Lima'], correct: [0] }]);
    const rPul = await mk('Pulsa', 'pulsador', {}, [{ statement: '¿Quién?', answer: 'Yo' }]);
    const g2 = (await api('/games', { method: 'POST', body: { name: 'Otro juego', status: 'published' } })).data;
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });
    await api(`/games/${g2.id}/session`, { method: 'POST', body: {} });
    const d = director(g.id);
    await connected(d); await until(() => d.state);

    // ── Arranca el complemento como lo haría el programa Stream Deck ──
    const wss = new WebSocket.Server({ port: SDPORT, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
        sd.ws = ws;
        ws.on('message', (raw) => {
            const m = JSON.parse(String(raw)); sd.msgs.push(m);
            if (m.event === 'registerPlugin') sd.registered = m.uuid === 'PLUGIN-UUID';
            if (m.event === 'getGlobalSettings') ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: sd.globals || {} } }));
            if (m.event === 'setImage') sd.images.set(m.context, m.payload.image);
            if (m.event === 'setFeedback') sd.feedback.set(m.context, Object.assign(sd.feedback.get(m.context) || {}, m.payload));
            if (m.event === 'showAlert') sd.alerts.push(m.context);
        });
    });
    sd.globals = { server: B, key: created.key };
    plugin = spawn(process.execPath, [path.join(built.dir, 'bin', 'plugin.js'), '-port', String(SDPORT), '-pluginUUID', 'PLUGIN-UUID', '-registerEvent', 'registerPlugin', '-info', '{}'], { stdio: ['ignore', 'pipe', 'pipe'] });
    plugin.stderr.on('data', x => process.stdout.write('[plugin-err] ' + x));
    await until(() => sd.registered, 6000);
    check('El complemento arranca y se registra en el programa Stream Deck', sd.registered);
    ['status', 'next-step', 'buzz-team', 'correct', 'timer', 'ranking', 'music', 'volume', 'round'].forEach((a, i) => appear('k' + i, a, a === 'round' ? { mode: 'num', num: 2 } : a === 'volume' ? { target: 'music', step: 10 } : {}));
    ['dial-volume', 'dial-timer', 'dial-round'].forEach((a, i) => appear('e' + i, a, {}, 'Encoder'));
    await until(() => /Sin juego/.test(textOf('k0')), 6000);
    check('Sin emparejar: la tecla «Estado» lo dice y explica dónde se empareja', /Sin juego/.test(textOf('k0')) && /Empar/.test(textOf('k0')), textOf('k0'));
    await until(() => d.decks && d.decks[0] && d.decks[0].online);
    check('El coordinador ve el Stream Deck conectado (botón «🎛 Stream Deck»)', d.decks && d.decks[0].name === 'PC de sala' && d.decks[0].online === true && d.decks[0].gameId === null, d.decks);
    sd.alerts = []; press('k1', 'next-step'); await wait(400);
    check('Sin emparejar, las teclas no hacen nada (aviso ⚠ en la tecla)', sd.alerts.includes('k1') && d.state.director.phase !== 'round_intro');

    // ── Emparejar ──
    d.emit('director:deck_pair', { keyId: created.id, on: true });
    await until(() => /Juego del Deck/.test(textOf('k0')), 6000);
    check('«Usar aquí» en el coordinador: el Stream Deck pasa a manejar ese juego', /Juego del Deck/.test(textOf('k0')) && /Conectado/.test(textOf('k0')), textOf('k0'));
    await until(() => d.decks && d.decks[0].gameId === g.id);
    check('…y el coordinador lo ve emparejado', d.decks[0].gameId === g.id && d.decks[0].gameName === 'Juego del Deck');
    await until(() => /Ronda/.test(textOf('k1')));
    check('«Siguiente paso» propone la primera ronda de la escaleta', /Ronda: Preguntas/.test(textOf('k1')), textOf('k1'));
    check('«Ronda nº 2» enseña cuál es', /Ronda 2\/2/.test(textOf('k8')) && /Pulsa/.test(textOf('k8')), textOf('k8'));

    // ── «Siguiente paso» de principio a fin (multirespuesta) ──
    const flow = [];
    const stepTo = async (phaseOk) => { const label = textOf('k1'); flow.push(label); press('k1', 'next-step'); return until(() => phaseOk(d.state.director)); };
    await stepTo(x => x.phase === 'round_intro' && x.currentRoundId === rMul.id);
    await until(() => /Empezar ronda/.test(textOf('k1')));
    await stepTo(x => x.phase === 'question');
    await until(() => /Abrir opciones/.test(textOf('k1')));
    await stepTo(x => x.optionsRevealed);
    await until(() => /Mostrar respuesta/.test(textOf('k1')), 8000);
    await stepTo(x => x.phase === 'answer_revealed');
    await until(() => /Siguiente pregunta/.test(textOf('k1')));
    await stepTo(x => x.phase === 'question' && x.currentQuestionIdx === 1);
    check('«Siguiente paso» recorre la prueba: ronda → empezar → abrir opciones → respuesta → siguiente pregunta', flow.length === 5 && /Ronda/.test(flow[0]) && /Empezar ronda/.test(flow[1]) && /Abrir opciones/.test(flow[2]) && /Mostrar respuesta/.test(flow[3]) && /Siguiente pregunta/.test(flow[4]) && d.state.director.currentQuestionIdx === 1, flow);

    // ── Crono: tecla y rueda (también restar) ──
    await until(() => d.state.director.preCountdown === 0 || !d.state.director.preCountdown, 7000);
    const tRun = d.state.director.timer.running;
    press('k4', 'timer'); await until(() => d.state.director.timer.running !== tRun);
    check('Tecla del crono: para y arranca el tiempo', d.state.director.timer.running !== tRun);
    if (d.state.director.timer.running) { press('k4', 'timer'); await until(() => !d.state.director.timer.running); }
    const r0 = d.state.director.timer.remaining;
    rotate('e1', 'dial-timer', 2); await until(() => d.state.director.timer.remaining === r0 + 10);
    const r1 = d.state.director.timer.remaining;
    rotate('e1', 'dial-timer', -1); await until(() => d.state.director.timer.remaining === r1 - 5);
    check('Rueda del crono: +5 s por paso y también resta', r1 === r0 + 10 && d.state.director.timer.remaining === r1 - 5, [r0, r1, d.state.director.timer.remaining]);
    rotate('e1', 'dial-timer', -40); await until(() => d.state.director.timer.remaining === 1);
    check('Restando, el tiempo no baja de 1 s', d.state.director.timer.remaining === 1);
    await until(() => sd.feedback.get('e1') && /Crono/.test(sd.feedback.get('e1').title));
    check('La franja del + enseña el crono con su barra', sd.feedback.get('e1') && /^\d+:\d\d$/.test(sd.feedback.get('e1').value) && typeof sd.feedback.get('e1').indicator.value === 'number', sd.feedback.get('e1'));

    // ── Ronda por número y pulsador ──
    press('k8', 'round'); await until(() => d.state.director.currentRoundId === rPul.id);
    check('«Ronda nº 2» lanza esa ronda', d.state.director.currentRoundId === rPul.id && d.state.director.phase === 'round_intro');
    press('k1', 'next-step'); await until(() => d.state.director.phase === 'question');
    await until(() => /Abrir pulsador/.test(textOf('k1')));
    check('En pulsador, «Siguiente paso» abre el pulsador', /Abrir pulsador/.test(textOf('k1')), textOf('k1'));
    press('k1', 'next-step'); await until(() => d.state.pulsadorActivo);
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const pad = io(B, { query: { gameId: g.id, deviceId: 'ipad1', pass }, transports: ['websocket'], forceNew: true });
    await connected(pad); pad.emit('player:register_team', { name: 'Los Linces', deviceId: 'ipad1' }); await wait(500);
    pad.emit('pulsar_boton');
    await until(() => /Los Linces/.test(textOf('k2')));
    check('La tecla «Equipo que pulsó» enseña quién ha pulsado', /Los Linces/.test(textOf('k2')), textOf('k2'));
    check('…y «Siguiente paso» espera a que decidas (✓ o ✗)', /Los Linces/.test(textOf('k1')), textOf('k1'));
    const tid = d.state.equipos.find(e => e.nombre === 'Los Linces').id;
    press('k3', 'correct'); await until(() => (d.state.director.scores[tid] || 0) > 0);
    check('«Correcto» da los puntos al equipo que pulsó', d.state.director.scores[tid] > 0 && d.state.director.buzzerWinner === tid, d.state.director.scores[tid]);

    // ── Pantalla de sala y sonido ──
    press('k5', 'ranking'); await until(() => d.state.director.scoreboardVisible);
    await until(() => /Ranking/.test(textOf('k5')));
    check('«Ranking» lo enseña en la sala', d.state.director.scoreboardVisible === true);
    press('k5', 'ranking'); await until(() => !d.state.director.scoreboardVisible);
    press('k6', 'music'); await until(() => d.state.director.sound.bg.playing);
    await until(() => /Sonando/.test(textOf('k6')));
    check('Tecla de música: pone la música propia y lo enseña', d.state.director.sound.bg.playing && /Sonando/.test(textOf('k6')) && /fondo/i.test(textOf('k6')), textOf('k6'));
    const v0 = d.state.director.sound.bgVol;
    press('k7', 'volume'); await until(() => d.state.director.sound.bgVol === Math.min(100, v0 + 10));
    check('Tecla de volumen +10 %', d.state.director.sound.bgVol === Math.min(100, v0 + 10), [v0, d.state.director.sound.bgVol]);
    const v1 = d.state.director.sound.bgVol;
    rotate('e0', 'dial-volume', -3); await until(() => d.state.director.sound.bgVol === v1 - 6 && sd.feedback.get('e0') && sd.feedback.get('e0').value === (v1 - 6) + ' %');
    check('Rueda de volumen: −2 % por paso (y la franja lo enseña al momento)', d.state.director.sound.bgVol === v1 - 6 && sd.feedback.get('e0').value === (v1 - 6) + ' %', [v1, d.state.director.sound.bgVol, sd.feedback.get('e0') && sd.feedback.get('e0').value]);
    dialPush('e0', 'dial-volume'); await until(() => !d.state.director.sound.bg.playing);
    check('Pulsar la rueda de volumen pausa la música', d.state.director.sound.bg.playing === false);
    rotate('e2', 'dial-round', 1); await wait(300);
    const fr = sd.feedback.get('e2');
    check('Rueda de rondas: al girar enseña el nombre de la ronda elegida', fr && /Ronda \d\/2/.test(fr.title) && /Preguntas|Pulsa/.test(fr.value), fr);
    const chosen = fr && fr.value;
    dialPush('e2', 'dial-round'); await until(() => d.state.director.currentRound && d.state.director.currentRound.name === chosen && d.state.director.phase === 'round_intro');
    check('…y al pulsarla la lanza', d.state.director.currentRound && d.state.director.currentRound.name === chosen && d.state.director.phase === 'round_intro');

    // ── Seguridad ──
    let rejected = false;
    const bad = io(B, { query: { gameId: g.id }, transports: ['websocket'], forceNew: true, auth: { deckKey: 'gsd_' + 'x'.repeat(32) } });
    bad.on('deck:status', s => { if (!s.ok) rejected = true; });
    await until(() => rejected || bad.disconnected === true && bad.io.engine == null, 3000); await wait(300);
    check('Una clave inventada no entra', rejected);
    bad.close();
    const other = io(B, { query: { gameId: g2.id }, transports: ['websocket'], forceNew: true, auth: { deckKey: created.key } });
    let otherAuth = false; other.on('auth_required', () => { otherAuth = true; });
    await connected(other);
    const d2 = director(g2.id); await connected(d2); await until(() => d2.state);
    other.emit('director:show_waiting'); await wait(500);
    check('Con la clave buena, en un juego con el que no está emparejado no manda nada', otherAuth && d2.state.director.phase !== 'waiting');
    other.emit('director:deck_pair', { keyId: created.id, on: true }); await wait(300);
    check('Un Stream Deck no puede emparejarse solo', (await api('/deck/keys')).data.items[0].gameId === g.id);
    other.close(); d2.close();
    check('No hay «Reset puntos» ni «Borrar todo» entre las acciones', !uuids.some(u => /reset|borrar|full/i.test(u)));

    // ── Anular la clave ──
    await api('/deck/keys/' + created.id, { method: 'DELETE' });
    await until(() => /Clave no válida/.test(textOf('k0')), 6000);
    check('Anular la clave en el backoffice: el Stream Deck lo dice y deja de mandar', /Clave no válida/.test(textOf('k0')), textOf('k0'));
    const ph = d.state.director.phase;
    press('k1', 'next-step'); await wait(600);
    check('…y sus teclas ya no hacen nada', d.state.director.phase === ph);
    check('El coordinador deja de verlo', (await until(() => d.decks && d.decks.length === 0)) === true);

    pad.close(); d.close();
    try { plugin.kill(); } catch {}
    wss.close();
    server.kill(); await new Promise(r => server.once('exit', r));
    const okN = results.filter(Boolean).length;
    console.log(`\n${okN}/${results.length} comprobaciones correctas`);
    process.exit(okN === results.length ? 0 : 1);
})().catch(async e => { console.error(e); try { plugin && plugin.kill(); server && server.kill(); } catch {} process.exit(1); });
