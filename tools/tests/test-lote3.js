// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-lote3.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Pruebas del Lote 3 (puerto 3202, BD temporal).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const REPO = path.resolve(__dirname, '..', '..');
const XLSX = require(REPO + '/node_modules/xlsx');
const PORT = 3202, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(require('os').tmpdir(), 'gameshow-testdata-lote3');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex'); // el servidor de prueba arranca con esta contraseña
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }
async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning|\[socket /.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('no arrancó');
}
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { ...(opts.raw ? {} : { 'Content-Type': 'application/json' }), cookie }, body: opts.raw || (opts.body ? JSON.stringify(opts.body) : undefined) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return { status: res.status, data: await res.json() };
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
}
const connected = (s) => new Promise(r => s.connected ? r() : s.once('connect', r));

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    await api('/auth/login', { method: 'POST', body: { password: PW } });

    // ── Juego: vaciar código/nota/fecha; código con espacios
    let g = (await api('/games', { method: 'POST', body: { name: 'L3', status: 'draft', access_code: ' 1234 ', note: 'n', date: '2026-10-10' } })).data;
    check('código guardado sin espacios', g.access_code === '1234', g.access_code);
    g = (await api(`/games/${g.id}`, { method: 'PUT', body: { name: 'L3', access_code: '', note: '', date: '' } })).data;
    check('se puede quitar código, nota y fecha', g.access_code === null && g.note === null && g.date === null, { c: g.access_code, n: g.note, d: g.date });

    // ── Rondas y preguntas
    const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'B', type: 'boom', config: { basePoints: 0, bonusMax: 0 } } })).data;
    const q1 = (await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: { statement: 'x', items: ['a', 'b'], correct_order: [0, 1] } } })).data;
    const q2 = (await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: { statement: 'y', items: ['a', 'b'], correct_order: [] } } })).data;
    const chType = await api(`/rounds/${r.id}`, { method: 'PUT', body: { type: 'pulsador' } });
    check('no se cambia el tipo de una ronda con preguntas', chType.status === 400, chType.data);
    await api(`/questions/${q1.id}`, { method: 'DELETE' });
    const pub = await api(`/games/${g.id}`, { method: 'PUT', body: { status: 'published' } });
    check('boom sin orden correcto no se puede publicar', pub.status === 400 && pub.data.incomplete && pub.data.incomplete[0].missing.includes('correct_order'), pub.data);
    check('el aviso numera por posición (no por sort_order)', pub.data.incomplete && pub.data.incomplete[0].question === 1, pub.data.incomplete);
    const ri = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'I', type: 'imagen' } })).data;
    await api(`/rounds/${ri.id}/questions`, { method: 'POST', body: { content: { image: '/uploads/images/x.png' } } });
    await api(`/questions/${q2.id}`, { method: 'PUT', body: { content: { statement: 'y', items: ['a', 'b'], correct_order: [1, 0] } } });
    const pub2 = await api(`/games/${g.id}`, { method: 'PUT', body: { status: 'published' } });
    check('imagen sin respuesta es válida y boom corregido publica', pub2.status === 200, pub2.data);
    // quitar premio/overrides y media_url
    await api(`/questions/${q2.id}`, { method: 'PUT', body: { config: { premio: { tipo: 'freeze' }, basePoints: 0 }, media_url: '/uploads/images/m.png' } });
    let tree = (await api(`/games/${g.id}`)).data;
    const qq = tree.rounds.find(x => x.id === r.id).questions[0];
    check('override 0 se guarda', qq.config.basePoints === 0, qq.config);
    await api(`/questions/${q2.id}`, { method: 'PUT', body: { config: {}, media_url: null } });
    tree = (await api(`/games/${g.id}`)).data;
    const qq2 = tree.rounds.find(x => x.id === r.id).questions[0];
    check('se puede quitar premio/overrides e imagen de la pregunta', (!qq2.config || !Object.keys(qq2.config).length) && qq2.media_url === null, { c: qq2.config, m: qq2.media_url });
    check('ronda con bonus 0 se conserva', tree.rounds.find(x => x.id === r.id).config.bonusMax === 0);

    // ── Biblioteca: borrar un archivo en uso pide confirmación
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'usada.png');
    const up = await (await fetch(B + '/api/upload/image', { method: 'POST', body: fd, headers: { cookie } })).json();
    await api(`/rounds/${ri.id}/questions`, { method: 'POST', body: { content: { image: up.url } } });
    const del1 = await api('/media/images/' + up.url.split('/').pop(), { method: 'DELETE' });
    check('borrar archivo en uso → aviso con el juego', del1.status === 409 && del1.data.inUse.some(x => x.includes('L3')), del1.data);
    const del2 = await api('/media/images/' + up.url.split('/').pop() + '?force=1', { method: 'DELETE' });
    check('…y con confirmación sí se borra', del2.status === 200);

    // ── Excel: hoja Rondas con tipo en mayúsculas/acentos, tipo inválido, orden, huecos en opciones
    const wb = XLSX.utils.book_new();
    const sheet = (rows) => XLSX.utils.aoa_to_sheet([['t'], [], ['h'], ...rows]);
    XLSX.utils.book_append_sheet(wb, sheet([['Zeta', 'Multirespuesta', 20, 0, 0, 0], ['Alfa', 'BOOM', 20, 100, 50, 0], ['Mala', 'loquesea']]), 'Rondas');
    XLSX.utils.book_append_sheet(wb, sheet([['Zeta', '¿Cuál?', 'uno', '', 'tres', 'cuatro', '', 3]]), 'Multirespuesta');
    XLSX.utils.book_append_sheet(wb, sheet([['Alfa', 'Ordena', 'a', 'b', 'c', '', '', '']]), 'Boom');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const g2 = (await api('/games', { method: 'POST', body: { name: 'XL', theme: { freezeMode: 'pregunta', primaryColor: '#ff0000' } } })).data;
    const fx = new FormData(); fx.append('file', new Blob([buf]), 'p.xlsx');
    const imp = await (await fetch(B + `/api/games/${g2.id}/import-excel`, { method: 'POST', body: fx, headers: { cookie } })).json();
    check('tipo no reconocido → error, no se crea la ronda', imp.errors.some(e => /no reconocido/.test(e)), imp.errors);
    const t2 = (await api(`/games/${g2.id}`)).data;
    check('orden de la hoja Rondas respetado (Zeta antes que Alfa)', t2.rounds.map(x => x.name).join(',') === 'Zeta,Alfa', t2.rounds.map(x => x.name));
    const mq = t2.rounds[0].questions[0].content;
    check('opción vacía en medio no desplaza la correcta ("3" = "tres")', mq.options[mq.correct[0]] === 'tres', mq);
    check('ronda con puntos base 0 desde Excel', t2.rounds[0].config.basePoints === 0, t2.rounds[0].config);
    const bq = t2.rounds[1].questions[0].content;
    check('boom sin orden en Excel = orden escrito', JSON.stringify(bq.correct_order) === '[0,1,2]', bq);
    // exportar y volver a importar: el tema no pierde freezeMode
    const xl = await api(`/games/${g2.id}/export-excel`);
    const fx2 = new FormData(); fx2.append('file', new Blob([xl.data]), 'e.xlsx');
    await fetch(B + `/api/games/${g2.id}/import-excel`, { method: 'POST', body: fx2, headers: { cookie } });
    const t3 = (await api(`/games/${g2.id}`)).data;
    check('la hoja Configuración no borra freezeMode del tema', t3.theme && t3.theme.freezeMode === 'pregunta', t3.theme);

    // ── Sockets: congelado sin bonos, equipo borrado, contraseña cambiada
    await api(`/games/${g.id}/session`, { method: 'POST', body: {} });
    const passRes = (await api(`/games/${g.id}/join`, { method: 'POST', body: { code: '' } })).data.pass;
    const d = io(B, { query: { gameId: g.id }, transports: ['websocket'], extraHeaders: { cookie } });
    d.on('game:director_sync', st => { d.state = st; }); d.on('connect', () => d.emit('director:join'));
    await connected(d);
    const p = io(B, { query: { gameId: g.id, deviceId: 'x1', pass: passRes }, transports: ['websocket'], forceNew: true });
    const pev = []; p.onAny((ev, data) => pev.push({ ev, data }));
    await connected(p); p.emit('player:register_team', { name: 'T', deviceId: 'x1' }); await wait(500);
    const tid = d.state.equipos[0].id;
    d.emit('admin_gestionar_bono', { equipoId: tid, accion: 'add', tipo: 'lock_all' });
    d.emit('director:block_team', { teamId: tid }); await wait(300);
    p.emit('usar_bono', { tipo: 'lock_all' }); await wait(300);
    check('equipo congelado no puede usar bonos', pev.some(e => e.ev === 'notificacion_bono' && /congelados/.test(e.data.msg)) && d.state.equipos[0].bonos.length === 1);
    d.emit('director:remove_team', { teamId: tid }); await wait(300);
    p.emit('pulsar_boton'); p.emit('player:submit_answer', { answer: 0 }); await wait(300);
    check('equipo borrado: sus envíos ya no cuentan', !(tid in d.state.director.scores) && !(tid in d.state.director.answers));
    let authReq = false; d.on('auth_required', () => { authReq = true; });
    await api('/auth/password', { method: 'PUT', body: { current: PW, password: 'OtraClave-2026' } });
    d.emit('director:toggle_scoreboard'); await wait(300);
    check('tras cambiar la contraseña, el coordinador abierto debe volver a entrar', authReq);

    // ── Login: next solo interno
    const safeNext = (n) => { try { const u = new URL(n || '/admin/', 'http://h'); return u.origin === 'http://h' ? u.pathname + u.search : '/admin/'; } catch { return '/admin/'; } };
    check('login: /\\\\evil.com y tabulador no redirigen fuera', safeNext('/\\evil.com') === '/admin/' && safeNext('/\t/evil.com') === '/admin/' && safeNext('/director/x') === '/director/x');

    d.close(); p.close(); server.kill();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); process.exit(1); });
