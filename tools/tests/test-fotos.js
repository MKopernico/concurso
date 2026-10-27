// Ejecutar desde la carpeta del proyecto:  node tools/tests/test-fotos.js
// Arranca su propio servidor con una base de datos temporal (no toca tus datos).
// Fotos reducidas al subir (shared/image-shrink.js): reglas sueltas en Node y, con Edge sin
// ventana, fotos de verdad en el backoffice: grande → JPEG ≤ 1920, logo con transparencia → PNG
// (recorte con mucho detalle → WebP transparente),
// orientación EXIF del móvil, SVG / GIF animado / foto ligera intactos, y subida real al servidor.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3215;
const B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'gameshow-testdata-fotos');
const PROFILE = path.join(os.tmpdir(), 'gameshow-edge-fotos');
const PW = 'pruebas-' + require('crypto').randomBytes(6).toString('hex');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let server = null;
const results = [];
function check(name, ok, info) { results.push(!!ok); console.log((ok ? 'OK   ' : 'FALLO') + ' ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); }

async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: process.env.GAMESHOW_TEST_APP || REPO, env: { ...process.env, PORT: String(PORT), GAMESHOW_DATA_DIR: DATA, ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning/.test(s)) process.stdout.write('[srv-err] ' + s); });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/ping')).ok) return; } catch {} await wait(200); }
    throw new Error('el servidor no arrancó');
}

// GIF de 1×1 con 1 o 2 fotogramas
function gif(frames) {
    const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
    const frame = [0x21, 0xF9, 0x04, 0, 10, 0, 0, 0, 0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0];
    const out = head.slice();
    for (let i = 0; i < frames; i++) out.push(...frame);
    out.push(0x3B);
    return Uint8Array.from(out);
}

// Lo que se ejecuta dentro del backoffice (Edge): genera las fotos con un lienzo y las pasa por
// ImageShrink.shrink y por uploadFile del propio backoffice.
const IN_PAGE = String.raw`
    const canvasBlob = (w, h, type, q, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return new Promise(r => c.toBlob(r, type, q)); };
    const noise = (ctx, w, h) => { const d = ctx.createImageData(w, h); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = (i / 4 % w) / w * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; } ctx.putImageData(d, 0, 0); };
    const decode = async (file) => { const url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url); return { w: c.width, h: c.height, px: (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data) }; };
    const sum = (r) => ({ reduced: r.reduced, type: r.file.type, name: r.file.name, before: r.before, after: r.after, width: r.width, height: r.height, note: r.note, reason: r.reason });
    const out = {};

    // 1) Foto grande (4000×3000, JPEG casi sin comprimir: unos MB)
    const big = new File([await canvasBlob(4000, 3000, 'image/jpeg', 0.98, noise)], 'Massey Ferguson.JPG', { type: 'image/jpeg' });
    const rBig = await ImageShrink.shrink(big);
    out.big = sum(rBig); out.bigDec = await decode(rBig.file).then(d => ({ w: d.w, h: d.h }));

    // 2) Logo PNG con transparencia (3000×1500, colores planos): sigue siendo PNG y transparente
    const logo = new File([await canvasBlob(3000, 1500, 'image/png', 1, (ctx, w, h) => { ctx.fillStyle = '#0822e2'; ctx.beginPath(); ctx.arc(1500, 750, 700, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 300px sans-serif'; ctx.fillText('AGRO', 1150, 850); })], 'logo.png', { type: 'image/png' });
    const rLogo = await ImageShrink.shrink(logo);
    const dl = await decode(rLogo.file);
    out.logo = sum(rLogo); out.logoDec = { w: dl.w, h: dl.h, corner: dl.px(5, 5), centre: dl.px(dl.w / 2, dl.h / 2 - 300) };

    // 2b) Recorte con mucho detalle y transparencia: el PNG pesaría más que el original → WebP transparente
    const cut = new File([await canvasBlob(3000, 1500, 'image/png', 1, (ctx, w, h) => { noise(ctx, w, h); ctx.clearRect(0, 0, 600, 600); })], 'recorte.png', { type: 'image/png' });
    const rCut = await ImageShrink.shrink(cut);
    const dc = await decode(rCut.file);
    out.cut = sum(rCut); out.cutDec = { w: dc.w, h: dc.h, corner: dc.px(5, 5), centre: dc.px(dc.w / 2, dc.h - 5) };

    // 3) PNG opaco grande → JPEG
    const opaque = new File([await canvasBlob(2500, 2500, 'image/png', 1, noise)], 'cartel.png', { type: 'image/png' });
    out.opaque = sum(await ImageShrink.shrink(opaque));

    // 4) Foto ya ligera (800×600) → intacta
    const small = new File([await canvasBlob(800, 600, 'image/jpeg', 0.7, (ctx) => { ctx.fillStyle = '#3a6'; ctx.fillRect(0, 0, 800, 600); })], 'peque.jpg', { type: 'image/jpeg' });
    const rSmall = await ImageShrink.shrink(small);
    out.small = sum(rSmall); out.smallSame = rSmall.file === small;

    // 5) SVG y GIF animado → intactos; audio → intacto
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="5000" height="5000" fill="red"/></svg>'], 'a.svg', { type: 'image/svg+xml' });
    const anim = new File([Uint8Array.from(window.__GIF2)], 'anim.gif', { type: 'image/gif' });
    const mp3 = new File([new Uint8Array(300000)], 'a.mp3', { type: 'audio/mpeg' });
    out.svgSame = (await ImageShrink.shrink(svg)).file === svg;
    const rAnim = await ImageShrink.shrink(anim);
    out.animSame = rAnim.file === anim; out.animReason = rAnim.reason;
    out.mp3Same = (await ImageShrink.shrink(mp3)).file === mp3;

    // 6) Foto de móvil apaisada en el archivo (3000×1000: izquierda roja, derecha azul) con EXIF
    // orientación 6 (girar 90° a la derecha): se ve vertical y lo rojo queda arriba
    const raw = new Uint8Array(await (await canvasBlob(3000, 1000, 'image/jpeg', 0.95, (ctx) => { ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 1500, 1000); ctx.fillStyle = '#00f'; ctx.fillRect(1500, 0, 1500, 1000); })).arrayBuffer());
    const exif = [0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const rotated = new Uint8Array(raw.length + exif.length); rotated.set(raw.slice(0, 2)); rotated.set(exif, 2); rotated.set(raw.slice(2), 2 + exif.length);
    const rRot = await ImageShrink.shrink(new File([rotated], 'IMG_0001.jpeg', { type: 'image/jpeg' }));
    const dr = await decode(rRot.file);
    out.rot = sum(rRot); out.rotDec = { w: dr.w, h: dr.h, top: dr.px(dr.w / 2, 20), bottom: dr.px(dr.w / 2, dr.h - 20) };

    // 7) Subida real con el código del backoffice (uploadFile): el servidor guarda la reducida
    const field = document.createElement('input'); field.name = 'test_field'; document.body.appendChild(field);
    await uploadFile({ files: [big], value: '' }, 'test_field');
    out.uploadedUrl = field.value;
    out.toast = Array.from(document.querySelectorAll('#toast .toast-msg')).map(t => t.textContent).join(' | ');
    return out;
`;

(async () => {
    // ── Reglas sueltas (sin navegador)
    const IS = require(path.join(REPO, 'public/shared/image-shrink.js'));
    check('GIF de 2 fotogramas = animado; de 1 = no', IS.isAnimatedGif(gif(2)) && !IS.isAnimatedGif(gif(1)));
    const t1 = IS.targetSize(4032, 3024), t2 = IS.targetSize(1000, 3000), t3 = IS.targetSize(800, 600);
    check('Tamaño final: lado mayor 1920, sin agrandar las pequeñas', t1.width === 1920 && t1.height === 1440 && t2.height === 1920 && t2.width === 640 && !t3.resize && t3.width === 800, [t1, t2, t3]);
    check('Se queda el original si el resultado pesa más o casi lo mismo sin redimensionar', !IS.worthIt(1000, 1200, true) && IS.worthIt(1000, 999, true) && !IS.worthIt(1000, 950, false) && IS.worthIt(1000, 880, false));
    check('Tamaños en español: «2,7 MB» y «380 KB»', IS.formatBytes(2.7 * 1024 * 1024) === '2,7 MB' && IS.formatBytes(380 * 1024) === '380 KB', [IS.formatBytes(2.7 * 1024 * 1024), IS.formatBytes(380 * 1024)]);
    const ns = await IS.shrink({ type: 'image/jpeg', size: 5e6, name: 'x.jpg' });
    check('Sin navegador (Node): devuelve el archivo tal cual, sin fallar', !ns.reduced && ns.file.name === 'x.jpg');

    if (!fs.existsSync(EDGE)) {
        console.log('SALTADO  la parte con navegador: no se encuentra Edge en ' + EDGE);
    } else {
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
            await cdp.waitFor(page, 'window.ImageShrink && typeof uploadFile === "function"');
            await page.eval(`window.__GIF2 = ${JSON.stringify(Array.from(gif(2)))}; return true;`);
            const o = await page.eval(IN_PAGE);

            check('Foto grande (4000×3000): sale JPEG de 1920×1440 y pesa menos', o.big.reduced && o.big.type === 'image/jpeg' && o.bigDec.w === 1920 && o.bigDec.h === 1440 && o.big.after < o.big.before, { antes: o.big.before, despues: o.big.after, ...o.bigDec });
            check('Foto grande: el nombre se conserva con extensión .jpg y el aviso dice cuánto', o.big.name === 'Massey Ferguson.jpg' && /^Foto reducida: [\d,]+ MB → [\d,]+ (KB|MB)$/.test(o.big.note), [o.big.name, o.big.note]);
            check('Logo PNG con transparencia: sigue PNG, 1920×960, transparente donde lo era', o.logo.reduced && o.logo.type === 'image/png' && o.logo.name === 'logo.png' && o.logoDec.w === 1920 && o.logoDec.h === 960 && o.logoDec.corner[3] === 0 && o.logoDec.centre[3] === 255, { ...o.logoDec, antes: o.logo.before, despues: o.logo.after });
            check('Recorte transparente con mucho detalle: WebP 1920×960 que conserva la transparencia', o.cut.reduced && o.cut.type === 'image/webp' && o.cut.name === 'recorte.webp' && o.cutDec.w === 1920 && o.cutDec.corner[3] === 0 && o.cutDec.centre[3] === 255 && o.cut.after < o.cut.before / 4, { ...o.cutDec, antes: o.cut.before, despues: o.cut.after });
            check('PNG opaco grande: pasa a JPEG', o.opaque.reduced && o.opaque.type === 'image/jpeg' && o.opaque.width === 1920, o.opaque);
            check('Foto ya ligera (800×600): se sube la original', !o.small.reduced && o.smallSame, o.small.reason);
            check('SVG, GIF animado y audio: se suben tal cual', o.svgSame && o.animSame && o.mp3Same, o.animReason);
            const red = (p) => p[0] > 200 && p[2] < 60, blue = (p) => p[2] > 200 && p[0] < 60;
            check('Foto de móvil con orientación EXIF: sale derecha (vertical 640×1920, lo rojo arriba)', o.rot.reduced && o.rotDec.w === 640 && o.rotDec.h === 1920 && red(o.rotDec.top) && blue(o.rotDec.bottom), o.rotDec);

            check('Subida desde el backoffice: el campo recibe la URL .jpg', /^\/uploads\/images\/massey-ferguson(-\d+)?\.jpg$/.test(o.uploadedUrl), o.uploadedUrl);
            check('Aviso tras subir: «Foto reducida: … → …»', /Archivo subido · Foto reducida: /.test(o.toast), o.toast);
            const onDisk = path.join(DATA, 'uploads', 'images', decodeURIComponent(o.uploadedUrl.split('/').pop()));
            const dims = fs.existsSync(onDisk) ? require(path.join(REPO, 'node_modules/image-size')).imageSize(fs.readFileSync(onDisk)) : {};
            const size = fs.existsSync(onDisk) ? fs.statSync(onDisk).size : -1;
            check('En el servidor se guarda la reducida (1920×1440, mismo peso que en el navegador)', dims.width === 1920 && dims.height === 1440 && size === o.big.after, { ...dims, size });

            await page.go(B + '/play/', 1500);
            check('Los iPads (/play) cargan el módulo para la foto del equipo', await page.eval('return !!window.ImageShrink && typeof uploadPhoto === "function";'));
            const sw = fs.readFileSync(path.join(REPO, 'public/play/sw.js'), 'utf8');
            check('El service worker de /play guarda el módulo para usarlo sin red', sw.includes("'/shared/image-shrink.js'"));
        } finally {
            await cdp.closeAll();
        }
    }

    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} comprobaciones correctas`);
    if (server) server.kill();
    process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); if (server) server.kill(); cdpClose().finally(() => process.exit(1)); });

function cdpClose() { try { return require(path.join(REPO, 'tools/capturas-manual/cdp.js')).closeAll(); } catch (e) { return Promise.resolve(); } }
