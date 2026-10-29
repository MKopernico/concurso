// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-reducir-subidas.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// «🗜 Reducir fotos pesadas» de la Biblioteca de medios (routes/media-reduce.js): con Edge sin
// ventana sube fotos sin reducir, las usa en dos juegos, las reduce con el botón del backoffice y
// comprueba: misma URL si no cambia el formato, URL nueva y referencias cambiadas si cambia
// (PNG opaco → JPEG, también si la referencia está escrita con %XX), la URL vieja redirige,
// copia de cada original en _originales, precarga con versión nueva, protecciones del servidor y
// «↩ Recuperar originales» que lo deja todo como estaba.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3216;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'gameshow-testdata-reducir');
const PROFILE = path.join(os.tmpdir(), 'gameshow-edge-reducir');
const PW = 'pruebas-' + crypto.randomBytes(6).toString('hex');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const IMAGES = path.join(DATA, 'uploads', 'images');
const BACKUPS = path.join(IMAGES, '_originales');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null;
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }
const sha = (file) => fs.existsSync(file) ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null;
const dims = (file) => { try { return require(path.join(REPO, 'node_modules/image-size')).imageSize(fs.readFileSync(file)); } catch { return {}; } };

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}

// Dentro del backoffice: fotos sin reducir (subidas a pelo, como antes de image-shrink) y dos juegos que las usan
const IN_SETUP = String.raw`
    const canvasBlob = (w, h, type, q, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return new Promise(r => c.toBlob(r, type, q)); };
    const noise = (ctx, w, h) => { const d = ctx.createImageData(w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = (i / 4 % w) / w * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; } ctx.putImageData(d, 0, 0); };
    const up = async (blob, name, type) => { const f = new FormData(); f.append('file', new File([blob], name, { type })); const r = await fetch('/api/upload/image', { method: 'POST', body: f }); const j = await r.json(); if (!j.url) throw new Error(name + ': ' + j.error + ' (' + blob.size + ' bytes)'); return j.url; };
    const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const u = {};
    u.big = await up(await canvasBlob(4000, 3000, 'image/jpeg', 0.9, noise), 'foto-grande.jpg', 'image/jpeg');
    // (ruido solo en una parte: entero pasaría del límite de 10 MB de subida)
    u.cartel = await up(await canvasBlob(2500, 2500, 'image/png', 1, (ctx, w, h) => { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#c33'); g.addColorStop(1, '#36c'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); noise(ctx, 1000, 1000); }), 'cartel-grande.png', 'image/png');
    u.logo = await up(await canvasBlob(3000, 1500, 'image/png', 1, (ctx) => { ctx.fillStyle = '#0822e2'; ctx.beginPath(); ctx.arc(1500, 750, 700, 0, 7); ctx.fill(); }), 'logo.png', 'image/png');
    u.small = await up(await canvasBlob(800, 600, 'image/jpeg', 0.7, (ctx) => { ctx.fillStyle = '#3a6'; ctx.fillRect(0, 0, 800, 600); }), 'peque.jpg', 'image/jpeg');
    u.unused = await up(await canvasBlob(3000, 2000, 'image/jpeg', 0.9, noise), 'sin-usar.jpg', 'image/jpeg');
    u.svg = await up(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="5000" height="5000" fill="red"/></svg>']), 'icono.svg', 'image/svg+xml');
    const gA = await post('/api/games', { name: 'Juego A', theme: { logo: u.logo } });
    const gB = await post('/api/games', { name: 'Juego B' });
    const rA = await post('/api/games/' + gA.id + '/rounds', { name: 'Fotos', type: 'imagen_fija', config: { background: u.small } });
    // El cartel se usa escrito con %2D en vez de «-»: tiene que reconocerse y cambiarse igual
    const qA = await post('/api/rounds/' + rA.id + '/questions', { content: { question: '¿Qué es?', image: u.cartel.replace('cartel-', 'cartel%2D'), icon: u.svg }, media_url: u.big });
    const rB = await post('/api/games/' + gB.id + '/rounds', { name: 'Fotos', type: 'imagen_fija' });
    await post('/api/rounds/' + rB.id + '/questions', { content: { question: 'Otra' }, media_url: u.big });
    return { u, gA: gA.id, gB: gB.id, qA: qA.id };
`;

const game = (id) => `return await (await fetch('/api/games/${id}')).json();`;
const assets = (id) => `return await (await fetch('/api/games/${id}/assets?role=director')).json();`;

(async () => {
    if (!fs.existsSync(EDGE)) { console.log('SALTADO: no se encuentra Edge en ' + EDGE); process.exit(0); }
    fs.rmSync(DATA, { recursive: true, force: true });
    await startServer();
    const cdp = require(path.join(REPO, 'tools/capturas-manual/cdp.js'));
    await cdp.launch(PROFILE);
    try {
        const page = await cdp.newPage();
        await page.size(1280, 900);
        await page.go(B + '/login/', 800);
        const login = await page.eval(`const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PW)} }) }); return r.status;`);
        check('Login en el backoffice (Edge)', login === 200, login);
        await page.go(B + '/admin/', 1500);
        await cdp.waitFor(page, 'window.ImageShrink && typeof openShrinkHeavy === "function"');
        const S = await page.eval(IN_SETUP);
        const file = (url) => path.join(IMAGES, decodeURIComponent(url.split('/').pop()));
        const orig = { big: sha(file(S.u.big)), cartel: sha(file(S.u.cartel)), logo: sha(file(S.u.logo)) };
        const sizeBefore = fs.statSync(file(S.u.big)).size;
        const assetsBefore = await page.eval(assets(S.gA));

        // ── Lista de fotos pesadas
        const heavy = await page.eval(`return await (await fetch('/api/media/images/heavy')).json();`);
        const names = heavy.files.map(f => f.name).sort();
        check('Lista solo las fotos de juegos con > 500 KB o > 1920 px (no la ligera, el SVG ni la que no usa nadie)', JSON.stringify(names) === JSON.stringify(['cartel-grande.png', 'foto-grande.jpg', 'logo.png']), names);
        const bigRow = heavy.files.find(f => f.name === 'foto-grande.jpg') || {};
        check('Cada foto dice su tamaño y qué juegos la usan', bigRow.width === 4000 && bigRow.height === 3000 && JSON.stringify(bigRow.games.sort()) === '["Juego A","Juego B"]' && heavy.undo === 0, bigRow);

        await page.eval('showMediaLibrary(); return true;');
        await cdp.waitFor(page, '/\\(3\\)/.test(document.getElementById("btnShrinkHeavy").textContent)');
        check('Botón «🗜 Reducir fotos pesadas (3)» en la biblioteca; «Recuperar originales» oculto', await page.eval('return document.getElementById("btnRestoreOriginals").style.display === "none";'));

        // ── Analizar (no cambia nada todavía)
        await page.eval('await openShrinkHeavy(); return true;');
        const modal = await page.eval('return { body: document.getElementById("shrink-body").innerText, go: document.getElementById("btnShrinkGo").textContent, goVisible: document.getElementById("btnShrinkGo").style.display !== "none" };');
        check('Ventana: cuánto se ahorra y botón «Reducir 3 fotos»', /3 fotos: [\d,]+ MB → [\d,]+ (KB|MB)/.test(modal.body) && /se ahorran/.test(modal.body) && modal.goVisible && modal.go === 'Reducir 3 fotos', modal.body.split('\n')[0]);
        check('Avisa del cambio de formato del PNG opaco («pasa a JPG»)', /cartel-grande\.png[\s\S]*pasa a JPG/.test(modal.body));
        check('Analizar no toca nada en el servidor', sha(file(S.u.big)) === orig.big && !fs.existsSync(BACKUPS));

        // ── Reducir
        await page.eval('await applyShrinkHeavy(); return true;');
        const toastTxt = await page.eval('return Array.from(document.querySelectorAll("#toast .toast-msg")).map(t => t.textContent).join(" | ");');
        check('Aviso final «3 fotos reducidas: … → …» y la ventana se cierra', /3 fotos reducidas: [\d,]+ MB → /.test(toastTxt) && !(await page.eval('return document.getElementById("modal-shrink-overlay").classList.contains("active");')), toastTxt);

        const dBig = dims(file(S.u.big));
        check('Foto JPEG: misma URL, ahora 1920×1440 y pesa menos', dBig.width === 1920 && dBig.height === 1440 && fs.statSync(file(S.u.big)).size < sizeBefore, { ...dBig, antes: sizeBefore, despues: fs.statSync(file(S.u.big)).size });
        check('Copia exacta de la original en images/_originales/', sha(path.join(BACKUPS, 'foto-grande.jpg')) === orig.big);

        const gA = await page.eval(game(S.gA)), gB = await page.eval(game(S.gB));
        const qA = gA.rounds[0].questions[0];
        const newCartel = qA.content.image;
        check('PNG opaco → JPEG con URL nueva y la pregunta ya apunta a ella (la referencia con %2D también)', newCartel === '/uploads/images/cartel-grande.jpg' && fs.existsSync(file(newCartel)) && !fs.existsSync(file(S.u.cartel)) && sha(path.join(BACKUPS, 'cartel-grande.png')) === orig.cartel, newCartel);
        check('Lo que no se reduce sigue igual (SVG, foto ligera de la ronda) y la foto compartida sigue en los dos juegos', qA.content.icon === S.u.svg && gA.rounds[0].config.background === S.u.small && qA.media_url === S.u.big && gB.rounds[0].questions[0].media_url === S.u.big);
        const logoUrl = gA.theme.logo, dLogo = dims(file(logoUrl));
        check('Logo con transparencia: 1920×960, copia guardada', dLogo.width === 1920 && dLogo.height === 960 && sha(path.join(BACKUPS, 'logo.png')) === orig.logo, { url: logoUrl, ...dLogo });

        const redir = await fetch(B + S.u.cartel, { redirect: 'manual' });
        check('La URL vieja del cartel redirige a la nueva (partidas en marcha, Excel antiguos)', redir.status === 302 && redir.headers.get('location') === '/uploads/images/cartel-grande.jpg', [redir.status, redir.headers.get('location')]);

        const assetsAfter = await page.eval(assets(S.gA));
        const vb = (a, url) => (a.files.find(f => f.url === url) || {}).ver;
        check('Precarga: lista las URLs nuevas, la foto con versión nueva (los iPads la vuelven a bajar) y nada falta', !assetsAfter.missing.length && vb(assetsAfter, newCartel) && vb(assetsAfter, S.u.big) && vb(assetsAfter, S.u.big) !== vb(assetsBefore, S.u.big) && assetsAfter.totalBytes < assetsBefore.totalBytes / 3, { antes: assetsBefore.totalBytes, despues: assetsAfter.totalBytes });

        const lib = await page.eval(`return await (await fetch('/api/media/images')).json();`);
        check('La biblioteca no muestra la carpeta _originales', !lib.some(f => f.name === '_originales') && lib.some(f => f.name === 'cartel-grande.jpg'));
        const heavy2 = await page.eval(`return await (await fetch('/api/media/images/heavy')).json();`);
        check('Ya no queda ninguna pesada (la JPEG de 1920 px con mucho detalle no se vuelve a ofrecer); 3 se pueden deshacer', heavy2.files.length === 0 && heavy2.undo === 3, { quedan: heavy2.files.map(f => f.name), undo: heavy2.undo });
        await cdp.waitFor(page, '/\\(3\\)/.test(document.getElementById("btnRestoreOriginals").textContent) && document.getElementById("btnRestoreOriginals").style.display !== "none"');
        check('Botón «↩ Recuperar originales (3)» visible y «Reducir» oculto (ya no hay nada que reducir)', await page.eval('return document.getElementById("btnShrinkHeavy").style.display === "none";'));

        // ── Protecciones del servidor
        const noSession = await fetch(B + '/api/media/images/heavy');
        const noSessionPost = await fetch(B + '/api/media/images/replace', { method: 'POST' });
        check('Sin sesión: 401 (lista y reemplazo)', noSession.status === 401 && noSessionPost.status === 401, [noSession.status, noSessionPost.status]);
        const guard = await page.eval(String.raw`
            const tiny = await new Promise(r => { const c = document.createElement('canvas'); c.width = c.height = 4; c.toBlob(r, 'image/jpeg', 0.5); });
            const heavier = await new Promise(r => { const c = document.createElement('canvas'); c.width = 1200; c.height = 900; const x = c.getContext('2d'); const d = x.createImageData(1200, 900); for (let i = 0; i < d.data.length; i++) d.data[i] = Math.random() * 255; x.putImageData(d, 0, 0); c.toBlob(r, 'image/jpeg', 1); });
            const send = async (url, blob, type) => { const f = new FormData(); f.append('url', url); f.append('file', new File([blob], 'x', { type })); const r = await fetch('/api/media/images/replace', { method: 'POST', body: f }); return r.status + ' ' + (await r.json()).error; };
            return {
                unused: await send(${JSON.stringify(S.u.unused)}, tiny, 'image/jpeg'),
                trav: await send('/uploads/images/../../db/games.db', tiny, 'image/jpeg'),
                backup: await send('/uploads/images/_originales/foto-grande.jpg', tiny, 'image/jpeg'),
                bigger: await send(${JSON.stringify(S.u.small)}, heavier, 'image/jpeg'),
                fake: await send(${JSON.stringify(S.u.big)}, new Blob(['<html>hola</html>']), 'image/png'),
            };`);
        check('Rechaza: foto que no usa ningún juego, rutas raras, copias, archivo dañado o que no pesa menos', /^400 /.test(guard.unused) && /^400 /.test(guard.trav) && /^400 /.test(guard.backup) && /^400 .*no pesa menos/.test(guard.bigger) && /^400 .*dañada/.test(guard.fake), guard);
        check('…y no ha tocado nada', sha(file(S.u.unused)) !== null && fs.readdirSync(BACKUPS).length === 3);

        // ── Deshacer
        await page.eval('window.confirm = () => true; await restoreOriginals(); return true;');
        const gA2 = await page.eval(game(S.gA));
        check('Recuperar originales: las 3 fotos vuelven a ser idénticas a las originales', sha(file(S.u.big)) === orig.big && sha(file(S.u.cartel)) === orig.cartel && sha(file(S.u.logo)) === orig.logo);
        check('…la pregunta y el tema vuelven a las URLs originales (el JPEG nuevo se queda: Excel o partidas con esa URL siguen viéndose)', gA2.rounds[0].questions[0].content.image === S.u.cartel && gA2.theme.logo === S.u.logo && fs.existsSync(file(newCartel)), gA2.rounds[0].questions[0].content.image);
        const heavy3 = await page.eval(`return await (await fetch('/api/media/images/heavy')).json();`);
        const back = await fetch(B + S.u.cartel, { redirect: 'manual' });
        check('…sin copias ni registro pendientes, sin redirección y otra vez 3 pesadas', fs.readdirSync(BACKUPS).length === 0 && heavy3.undo === 0 && heavy3.files.length === 3 && back.status === 200, { copias: fs.readdirSync(BACKUPS), undo: heavy3.undo, pesadas: heavy3.files.length, url: back.status });
        await cdp.waitFor(page, '/\\(3\\)/.test(document.getElementById("btnShrinkHeavy").textContent) && document.getElementById("btnShrinkHeavy").style.display !== "none"');
        check('…«Reducir fotos pesadas (3)» vuelve a aparecer y «Recuperar» se oculta', await page.eval('return document.getElementById("btnRestoreOriginals").style.display === "none";'));

        // ── Sin fotos pesadas, el botón no aparece al entrar en la biblioteca
        await page.eval(`for (const id of [${JSON.stringify(S.gA)}, ${JSON.stringify(S.gB)}]) await fetch('/api/games/' + id, { method: 'DELETE' }); return true;`);
        await page.go(B + '/admin/', 1500);
        await cdp.waitFor(page, 'typeof showMediaLibrary === "function"');
        await page.eval('showMediaLibrary(); return true;');
        await cdp.waitFor(page, 'document.querySelector("#media-grid .media-item")');
        await wait(800);
        const hidden = await page.eval('return [document.getElementById("btnShrinkHeavy").style.display, document.getElementById("btnRestoreOriginals").style.display];');
        check('Sin fotos pesadas en los juegos: ni «Reducir» ni «Recuperar» se ven', hidden[0] === 'none' && hidden[1] === 'none', hidden);
    } finally {
        await cdp.closeAll();
    }

    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    if (server) server.kill();
    process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); if (server) server.kill(); cdpClose().finally(() => process.exit(1)); });

function cdpClose() { try { return require(path.join(REPO, 'tools/capturas-manual/cdp.js')).closeAll(); } catch (e) { return Promise.resolve(); } }
