// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-kit.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Descargas del backoffice: kit offline y «juego offline» (puerto 3212, BD temporal).
// Además arranca el kit descargado (con su node.exe) y comprueba que carga el juego solo.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const REPO = path.resolve(__dirname, '..', '..');
const yauzl = require(REPO + '/node_modules/yauzl');
const PORT = 3212, KIT_PORT = 3213, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'gameshow-testdata-kit');
const WORK = path.join(os.tmpdir(), 'gameshow-testkit-work');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex'); // el servidor de prueba arranca con esta contraseña
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server, kitProc, cookie = '';
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }
async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning|\[socket /.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('no arrancó');
}
async function api(p, opts = {}) {
    const res = await fetch(B + '/api' + p, { method: opts.method || 'GET', headers: { ...(opts.raw ? {} : { 'Content-Type': 'application/json' }), cookie, ...(opts.headers || {}) }, body: opts.raw || (opts.body ? JSON.stringify(opts.body) : undefined) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return { status: res.status, headers: res.headers, data: await res.json() };
    return { status: res.status, headers: res.headers, data: Buffer.from(await res.arrayBuffer()) };
}
// Lista las entradas de un zip comprobando el CRC de cada una (yauzl valida tamaños; el CRC se calcula aquí)
function zipEntries(file) {
    const zlib = require('zlib');
    return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on('entry', (e) => {
            if (/\/$/.test(e.fileName)) return zip.readEntry();
            zip.openReadStream(e, (err2, s) => {
                if (err2) return reject(err2);
                let crc = 0;
                s.on('data', c => { crc = zlib.crc32(c, crc); });
                s.on('end', () => { out.push({ name: e.fileName, size: e.uncompressedSize, crcOk: crc >>> 0 === e.crc32 }); zip.readEntry(); });
                s.on('error', reject);
            });
        });
        zip.on('end', () => resolve(out));
        zip.on('error', reject);
        zip.readEntry();
    }));
}
function extract(file, dest) {
    return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        zip.on('entry', (e) => {
            const target = path.join(dest, e.fileName);
            if (/\/$/.test(e.fileName)) { fs.mkdirSync(target, { recursive: true }); return zip.readEntry(); }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            zip.openReadStream(e, (err2, s) => {
                if (err2) return reject(err2);
                s.pipe(fs.createWriteStream(target)).on('finish', () => zip.readEntry()).on('error', reject);
            });
        });
        zip.on('end', resolve);
        zip.on('error', reject);
        zip.readEntry();
    }));
}

(async () => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    await startServer();

    // ── Acceso
    const anon = await fetch(B + '/api/kit/download');
    check('sin sesión no se descarga el kit', anon.status === 401, anon.status);
    const anon2 = await fetch(B + '/api/games/x/offline-kit', { method: 'POST' });
    check('sin sesión no se prepara un juego offline', anon2.status === 401, anon2.status);
    const loginPage = await (await fetch(B + '/login/')).text();
    check('la página de acceso ofrece «Soy jugador» → /play/', /href="\/play\/"[^>]*>[^<]*Soy jugador/.test(loginPage));
    const home = await fetch(B + '/', { redirect: 'manual' });
    check('la portada sin sesión manda al acceso', home.status === 302 && /\/login\/\?next=%2F/.test(home.headers.get('location')), home.headers.get('location'));
    await api('/auth/login', { method: 'POST', body: { password: PW } });
    const homeIn = await (await fetch(B + '/', { headers: { cookie } })).text();
    check('portada con sesión: coordinador y backoffice', /Soy coordinador/.test(homeIn) && /href="\/admin\/"/.test(homeIn) && !/<strong>Soy jugador/.test(homeIn));

    // ── Juego con un archivo, para el «juego offline»
    const g = (await api('/games', { method: 'POST', body: { name: 'Kit Ñandú', status: 'draft' } })).data;
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'k.png');
    const up = await (await fetch(B + '/api/upload/image', { method: 'POST', body: fd, headers: { cookie } })).json();
    const r = (await api(`/games/${g.id}/rounds`, { method: 'POST', body: { name: 'R', type: 'imagen_fija' } })).data;
    await api(`/rounds/${r.id}/questions`, { method: 'POST', body: { content: { image: up.url } } });

    // App empaquetada del kit (GAMESHOW_TEST_APP): no monta kits, solo lo dice
    if (process.env.GAMESHOW_TEST_APP) {
        const un = (await api('/kit/status')).data;
        const unOff = await api('/games/' + g.id + '/offline-kit', { method: 'POST' });
        check('app del kit: kit y juego offline «no disponibles» (sin error)', un.status === 'unavailable' && unOff.status === 503 && unOff.data.status === 'unavailable', un);
        server.kill();
        const failed = results.filter(x => !x).length;
        console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
        process.exit(failed ? 1 : 0);
    }

    // ── Kit: se prepara bajo demanda (en local) y se consulta hasta que está listo
    const early = await api('/games/' + g.id + '/offline-kit', { method: 'POST' });
    check('juego offline con el kit sin preparar → 503 con estado', early.status === 503 && ['building', 'idle', 'ready'].includes(early.data.status), early.data);
    let st;
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) { st = (await api('/kit/status')).data; if (st.status !== 'building' && st.status !== 'idle') break; await wait(1000); }
    check('el kit queda listo', st.status === 'ready' && st.sizeMb > 20, { ...st, segundos: Math.round((Date.now() - t0) / 1000) });

    const dl = await api('/kit/download');
    const kitZip = path.join(WORK, 'kit.zip');
    fs.writeFileSync(kitZip, dl.data);
    check('descarga: tamaño, nombre y reanudable', dl.status === 200 && Number(dl.headers.get('content-length')) === dl.data.length
        && /GameShow-Offline\.zip/.test(dl.headers.get('content-disposition')) && dl.headers.get('accept-ranges') === 'bytes');
    const part = await api('/kit/download', { headers: { range: 'bytes=100-199' } });
    check('descarga por partes (206) coincide con el archivo', part.status === 206 && part.data.equals(dl.data.subarray(100, 200)));
    const kitEntries = await zipEntries(kitZip);
    const names = kitEntries.map(e => e.name);
    check('kit en pocos archivos (< 200)', kitEntries.length < 200, kitEntries.length);
    check('kit completo: node.exe, server.js empaquetado, sqlite, socket.io, arranque', ['node/node.exe', 'app/server.js', 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        'app/node_modules/socket.io/client-dist/socket.io.js', 'app/kit/start.js', 'app/db/schema.sql', 'ARRANCAR.bat', 'LEEME.txt', 'VERSION.txt', 'app/public/play/index.html']
        .every(n => names.includes('GameShow-Offline/' + n)));
    check('kit sin node_modules sobrantes', !names.some(n => /node_modules\/(express|lodash|xlsx|esbuild)\//.test(n)));
    check('CRC correcto en todas las entradas del kit', kitEntries.every(e => e.crcOk));
    const again = (await api('/kit/status')).data;
    check('sin cambios en el código se reutiliza el mismo kit', again.status === 'ready' && again.builtAt === st.builtAt);

    // ── Juego offline
    const off = await api('/games/' + g.id + '/offline-kit', { method: 'POST' });
    check('juego offline preparado', off.status === 200 && /^\/api\/offline-kit\/[0-9a-f]{24}$/.test(off.data.url) && off.data.missing === 0, off.data);
    const offDl = await fetch(B + off.data.url, { headers: { cookie } });
    const offBuf = Buffer.from(await offDl.arrayBuffer());
    const offZip = path.join(WORK, 'juego.zip');
    fs.writeFileSync(offZip, offBuf);
    check('nombre de la descarga con el juego', /GameShow-Offline - .*\.zip/.test(decodeURIComponent(offDl.headers.get('content-disposition') || '')), offDl.headers.get('content-disposition'));
    const offEntries = await zipEntries(offZip);
    const inner = offEntries.find(e => /^GameShow-Offline\/datos\/importar\/.+\.gameshow\.zip$/.test(e.name));
    check('kit + juego: mismas entradas del kit y el juego en datos/importar', offEntries.length === kitEntries.length + 1 && !!inner, inner && inner.name);
    check('CRC correcto en todas las entradas (incluido el juego añadido)', offEntries.every(e => e.crcOk));
    const offPart = await fetch(B + off.data.url, { headers: { cookie, range: 'bytes=1000-1999' } });
    check('juego offline reanudable (206)', offPart.status === 206 && Buffer.from(await offPart.arrayBuffer()).equals(offBuf.subarray(1000, 2000)));
    const bad = await api('/offline-kit/' + '0'.repeat(24));
    check('enlace inexistente → aviso de caducada', bad.status === 404 && /caducado/.test(bad.data.error));

    // ── Arrancar el kit descargado como lo haría el usuario: primera vez, contraseña, carga del juego
    if (process.platform === 'win32') {
        await extract(offZip, WORK);
        const K = path.join(WORK, 'GameShow-Offline');
        fs.mkdirSync(path.join(K, 'datos'), { recursive: true });
        fs.writeFileSync(path.join(K, 'datos', 'ajustes.env'), `ADMIN_PASSWORD=${PW}\r\nPORT=${KIT_PORT}\r\n`);
        let log = '';
        kitProc = spawn(path.join(K, 'node', 'node.exe'), ['app/kit/start.js'], { cwd: K, env: { ...process.env, GAMESHOW_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        kitProc.stdout.on('data', d => { log += d; }); kitProc.stderr.on('data', d => { log += d; });
        for (let i = 0; i < 100 && !/NO CIERRES/.test(log); i++) await wait(200);
        check('el kit arranca con su node.exe', /GameShow está funcionando/.test(log), log.slice(-300));
        check('el kit carga el juego solo al arrancar', /Juego «Kit Ñandú» cargado/.test(log));
        check('el zip del juego se aparta para no repetirlo', fs.readdirSync(path.join(K, 'datos', 'importar', 'importados')).length === 1);
        const KB = `http://127.0.0.1:${KIT_PORT}`;
        const kl = await fetch(KB + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
        const kc = (kl.headers.get('set-cookie') || '').split(';')[0];
        const kGames = await (await fetch(KB + '/api/games', { headers: { cookie: kc } })).json();
        const kg = kGames.find(x => x.name === 'Kit Ñandú');
        const tree = kg && await (await fetch(KB + '/api/games/' + kg.id, { headers: { cookie: kc } })).json();
        const img = tree && tree.rounds[0].questions[0].content.image;
        const imgRes = img && await fetch(KB + img);
        check('en el kit: juego con su ronda y su imagen', !!imgRes && imgRes.ok && Buffer.from(await imgRes.arrayBuffer()).equals(png), img);
        const sio = await fetch(KB + '/socket.io/socket.io.js');
        check('en el kit: cliente de socket.io servido', sio.ok && (await sio.text()).length > 10000);
        const kst = await (await fetch(KB + '/api/kit/status', { headers: { cookie: kc } })).json();
        check('dentro del kit no se ofrece descargar el kit', kst.status === 'unavailable', kst);
        kitProc.kill(); kitProc = null;
    } else {
        console.log('(no es Windows: no se arranca el kit descargado)');
    }

    server.kill();
    await wait(500);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); if (server) server.kill(); if (kitProc) kitProc.kill(); process.exit(1); });
