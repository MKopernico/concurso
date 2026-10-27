// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-sintonias.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Sintonías y música de fondo: qué sintonía suena (tipo, ronda propia, ronda sin sintonía), que no
// se repita al pasar de la categoría a la ronda, panel 🎵 del coordinador (volúmenes, automáticas,
// fondo), canción terminada en la pantalla, avisos de pantalla sin sonido, persistencia, precarga
// de la pantalla, exportación y que los iPads ni lo reciban ni lo puedan mandar.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3231;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-sintonias');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}
async function stopServer() { server.kill(); await new Promise(r => server.once('exit', r)); }
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await res.text(); try { return { status: res.status, data: JSON.parse(txt) }; } catch { return { status: res.status, data: txt }; }
}
async function uploadAudio(name) {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(2048, 7)], { type: 'audio/mpeg' }), name);
    return (await (await fetch(B + '/api/upload/audio', { method: 'POST', body: fd, headers: { cookie } })).json()).url;
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));
function director(gameId) {
    const d = io(B, { query: { gameId }, transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
    d.on('game:director_sync', s => { d.state = s; }); d.on('connect', () => d.emit('director:join'));
    return d;
}
function screen(gameId, embed) {
    const s = io(B, { query: { gameId }, transports: ['websocket'], forceNew: true });
    s.sync = null; s.jingles = []; s.stops = 0;
    s.on('game:player_sync', v => { s.sync = v; });
    s.on('game:jingle', j => s.jingles.push(j));
    s.on('game:jingle_stop', () => { s.stops++; });
    s.on('connect', () => s.emit('screen:join', { embed: !!embed }));
    return s;
}

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });

    const jBoom = await uploadAudio('Sintonia boom.mp3');
    const jPul = await uploadAudio('Sintonia pulsador.mp3');
    const jRonda = await uploadAudio('Sintonia final.mp3');
    const m1 = await uploadAudio('Fondo uno.mp3');
    const m2 = await uploadAudio('Fondo dos.mp3');
    const song = await uploadAudio('Cancion adivinar.mp3');
    check('Se suben los audios', [jBoom, jPul, jRonda, m1, m2, song].every(u => typeof u === 'string' && u.startsWith('/uploads/audio/')));

    const theme = { types: { boom: { jingle: jBoom }, pulsador: { jingle: jPul } }, music: [m1, m2], sound: { max: 12, fadeIn: false } };
    const g = (await api('/games', { method: 'POST', body: { name: 'Sintonías', status: 'published', theme } })).data;
    const mk = async (name, type, config, qs) => { const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name, type, config } })).data; for (const c of qs) await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: c } }); return r; };
    const rBoom = await mk('Boom', 'boom', { time: 30 }, [{ statement: 'Ordena', items: ['a', 'b'], correctOrder: [0, 1] }]);
    const rPulPropia = await mk('Final', 'pulsador', { jingle: jRonda }, [{ statement: 'P', answer: 'x' }]);
    const rPulMuda = await mk('Muda', 'pulsador', { jingle: 'none' }, [{ statement: 'P2', answer: 'y' }]);
    const rPul = await mk('Pulsa', 'pulsador', {}, [{ statement: 'P3', answer: 'z' }]);
    await mk('Canción', 'cancion', {}, [{ statement: '¿Qué canción?', answer: 'x', audio: song }]);
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });

    const d = director(g.id);
    await connected(d); await wait(400);
    const S = screen(g.id, false), E = screen(g.id, true);
    await connected(S); await connected(E); await wait(400);
    const pass = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const p = io(B, { query: { gameId: g.id, deviceId: 'ipad1', pass }, transports: ['websocket'], forceNew: true });
    p.sync = null; p.jingles = 0;
    p.on('game:player_sync', v => { p.sync = v; }); p.on('game:jingle', () => { p.jingles++; });
    await connected(p); p.emit('player:register_team', { name: 'Equipo 1', deviceId: 'ipad1' }); await wait(500);

    // ── Lo que recibe cada uno ──
    const sv = S.sync && S.sync.sound;
    check('La pantalla recibe el sonido del juego (tope 12 s, sin fundido de entrada, 2 canciones)', sv && sv.max === 12 && sv.fadeIn === false && sv.fadeOut === true && sv.bg.count === 2 && sv.bg.url === m1 && sv.bg.playing === false, sv);
    check('Volúmenes de partida: sintonías 80, fondo 35, automáticas', sv && sv.jingleVol === 80 && sv.bgVol === 35 && sv.auto === true);
    check('Los iPads no reciben nada de sonido', p.sync && p.sync.sound === null);

    // ── Qué sintonía suena ──
    d.emit('director:select_category', { category: 'boom' }); await wait(300);
    check('Elegir la categoría Boom hace sonar su sintonía en la pantalla', S.jingles.length === 1 && S.jingles[0].url === jBoom, S.jingles);
    check('También en la vista incrustada (ella decide si suena)', E.jingles.length === 1);
    check('Los iPads no reciben la sintonía', p.jingles === 0);
    d.emit('director:launch_round', { roundId: rBoom.id }); await wait(300);
    check('Lanzar la ronda justo después no la repite', S.jingles.length === 1, S.jingles.length);
    d.emit('director:launch_round', { roundId: rPulPropia.id }); await wait(300);
    check('Una ronda con sintonía propia suena con la suya', S.jingles.length === 2 && S.jingles[1].url === jRonda, S.jingles.map(j => j.url));
    d.emit('director:launch_round', { roundId: rPulMuda.id }); await wait(300);
    check('Una ronda «sin sintonía» no suena aunque su tipo tenga', S.jingles.length === 2);
    d.emit('director:launch_round', { roundId: rPul.id }); await wait(300);
    check('Una ronda sin nada propio suena con la de su tipo', S.jingles.length === 3 && S.jingles[2].url === jPul);
    d.emit('director:sound', { action: 'jingle' }); await wait(300);
    check('«▶ Sintonía» la vuelve a lanzar aunque acabe de sonar', S.jingles.length === 4 && S.jingles[3].url === jPul && S.jingles[3].id > S.jingles[2].id);
    d.emit('director:sound', { action: 'jingle_stop' }); await wait(300);
    check('«■» corta la sintonía en la pantalla', S.stops === 1 && d.state.director.sound.jingle === null);
    d.emit('director:launch_round', { roundId: rPulMuda.id }); await wait(200);
    d.emit('director:sound', { action: 'jingle' }); await wait(300);
    check('«▶ Sintonía» en una ronda sin sintonía no suena', S.jingles.length === 4);

    d.emit('director:sound', { action: 'set', auto: false }); await wait(300);
    d.emit('director:select_category', { category: 'pulsador' }); await wait(300);
    check('Con las automáticas quitadas, elegir categoría no suena', S.jingles.length === 4 && d.state.director.sound.auto === false);
    d.emit('director:sound', { action: 'jingle' }); await wait(300);
    check('…pero «▶ Sintonía» sí (la de la categoría elegida)', S.jingles.length === 5 && S.jingles[4].url === jPul);
    d.emit('director:sound', { action: 'set', auto: true }); await wait(200);

    // ── Ajustes ──
    d.emit('director:sound', { action: 'set', jingleVol: 150, bgVol: 'x', fadeOut: false, fadeIn: 'si' }); await wait(300);
    const sn = d.state.director.sound;
    check('Volumen fuera de rango se queda en 100; valores raros no cambian nada', sn.jingleVol === 100 && sn.bgVol === 35 && sn.fadeOut === false && sn.fadeIn === false, sn);
    d.emit('director:sound', { action: 'set', bgVol: 50.4, jingleVol: -3 }); await wait(300);
    check('Volúmenes redondeados y con suelo en 0', d.state.director.sound.bgVol === 50 && d.state.director.sound.jingleVol === 0 && S.sync.sound.bgVol === 50);
    d.emit('director:sound', { action: 'set', jingleVol: 70 }); await wait(200);

    // ── Música de fondo ──
    d.emit('director:sound', { action: 'bg_play' }); await wait(300);
    let bg = S.sync.sound.bg;
    check('▶ fondo: la pantalla recibe la primera canción en marcha', bg.playing === true && bg.idx === 0 && bg.url === m1, bg);
    E.emit('screen:bg_ended', { idx: bg.idx, seq: bg.seq }); await wait(300);
    check('La vista incrustada no puede pasar de canción', S.sync.sound.bg.idx === 0);
    S.emit('screen:bg_ended', { idx: bg.idx, seq: bg.seq }); await wait(300);
    check('Al acabar la canción en la pantalla pasa a la siguiente', S.sync.sound.bg.idx === 1 && S.sync.sound.bg.url === m2);
    S.emit('screen:bg_ended', { idx: bg.idx, seq: bg.seq }); await wait(300);
    check('Un aviso repetido (o de otra pantalla) no se salta otra', S.sync.sound.bg.idx === 1);
    bg = S.sync.sound.bg;
    S.emit('screen:bg_ended', { idx: bg.idx, seq: bg.seq }); await wait(300);
    check('Tras la última vuelve a la primera', S.sync.sound.bg.idx === 0 && S.sync.sound.bg.playing === true);
    d.emit('director:sound', { action: 'bg_prev' }); await wait(300);
    check('⏮ desde la primera va a la última', S.sync.sound.bg.idx === 1);
    const seqA = S.sync.sound.bg.seq;
    d.emit('director:sound', { action: 'bg_pick', idx: 1 }); await wait(300);
    check('Elegir la misma canción de la lista la empieza de nuevo', S.sync.sound.bg.idx === 1 && S.sync.sound.bg.seq > seqA);
    d.emit('director:sound', { action: 'bg_pick', idx: 'dos' }); await wait(200);
    check('Elegir una canción que no es número no hace nada', S.sync.sound.bg.idx === 1);
    d.emit('director:sound', { action: 'bg_pause' }); await wait(300);
    check('⏸ fondo', S.sync.sound.bg.playing === false);
    d.emit('director:sound', { action: 'bg_play' }); d.emit('director:sound', { action: 'jingle' }); await wait(300);
    const stopsBefore = S.stops;
    d.emit('director:sound', { action: 'silence' }); await wait(300);
    check('🔇 Silencio total: para el fondo y corta la sintonía', S.sync.sound.bg.playing === false && S.stops === stopsBefore + 1);

    // ── Aviso de pantalla sin sonido ──
    S.emit('screen:sound_state', { blocked: true }); E.emit('screen:sound_state', { blocked: true }); await wait(300);
    const ss = d.state.director.screensSound || {};
    check('La pantalla avisa al coordinador de que no puede sonar (la incrustada no cuenta)', Object.values(ss).filter(v => v === 'blocked').length === 1, ss);
    S.emit('screen:sound_state', { blocked: false }); await wait(300);
    check('…y de que ya suena tras el clic', Object.values(d.state.director.screensSound).every(v => v === 'ok'));
    S.emit('screen:sound_state', { blocked: true }); await wait(200);
    S.close(); await wait(400);
    check('Al cerrar la pantalla desaparece su aviso', Object.keys(d.state.director.screensSound || {}).length === 0);

    // ── Seguridad: un iPad no manda sobre el sonido ──
    p.emit('director:sound', { action: 'bg_play' }); p.emit('director:sound', { action: 'set', bgVol: 1 }); await wait(300);
    check('Un iPad no puede poner música ni tocar volúmenes', d.state.director.sound.bg.playing === false && d.state.director.sound.bgVol === 50);
    p.emit('screen:bg_ended', { idx: 1, seq: d.state.director.sound.bg.seq }); await wait(200);
    check('Un iPad no puede pasar de canción', d.state.director.sound.bg.idx === 1);

    // ── Persistencia (reinicio del servidor) y partida nueva ──
    d.emit('director:sound', { action: 'set', bgVol: 42, auto: false }); d.emit('director:sound', { action: 'bg_play' });
    await wait(2600);
    d.close(); E.close(); p.close();
    await stopServer(); await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const d2 = director(g.id); await connected(d2); await wait(500);
    const s2 = d2.state.director.sound;
    check('Tras reiniciar el servidor se conservan volúmenes, automáticas, fundidos y canción', s2.bgVol === 42 && s2.jingleVol === 70 && s2.auto === false && s2.fadeOut === false && s2.bg.idx === 1, s2);
    check('…y la música no arranca sola', s2.bg.playing === false);
    await api(`/games/${g.id}/session`, { method: 'POST', body: { nueva: true } }); await wait(500);
    d2.emit('director:join'); await wait(300);
    check('Partida nueva («Borrar todo»): volúmenes y automáticas siguen igual', d2.state.director.sound.bgVol === 42 && d2.state.director.sound.auto === false && d2.state.director.sound.bg.playing === false);
    check('…y los fundidos vuelven a los del backoffice', d2.state.director.sound.fadeIn === false && d2.state.director.sound.fadeOut === true, d2.state.director.sound);

    // ── Precarga y exportación ──
    const scr = (await api(`/games/${g.id}/assets?role=screen`)).data;
    const urls = scr.files.map(f => f.url);
    check('La pantalla precarga sintonías y música de fondo', [jBoom, jPul, jRonda, m1, m2].every(u => urls.includes(u)), urls);
    check('…pero no el audio de «Adivina la canción» (suena en el coordinador)', !urls.includes(song));
    const dir = (await api(`/games/${g.id}/assets?role=director`)).data.files.map(f => f.url);
    check('El coordinador sigue precargando todo el audio', dir.includes(song) && dir.includes(jBoom));
    const exp = await fetch(B + `/api/games/${g.id}/export-zip`, { headers: { cookie } });
    const zip = Buffer.from(await exp.arrayBuffer()).toString('latin1');
    const base = (u) => decodeURIComponent(u.split('/').pop());
    check('El .zip del juego lleva sintonías y música de fondo', exp.ok && [jBoom, jRonda, m2].every(u => zip.includes(base(u))));

    d2.close();
    await stopServer();
    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    process.exit(ok === results.length ? 0 : 1);
})().catch(async (e) => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
