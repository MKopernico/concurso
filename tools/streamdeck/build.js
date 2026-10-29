// Monta el complemento «GameShow» para Stream Deck:
//   node tools/streamdeck/build.js
// → public/descargas/GameShow.streamDeckPlugin (un zip con la carpeta com.kopernico.gameshow.sdPlugin;
//   doble clic y el programa Stream Deck lo instala) + GameShow.streamDeckPlugin.json (huella de las fuentes).
// El código va empaquetado con esbuild en un solo archivo (socket.io-client y ws incluidos): el
// programa Stream Deck lo ejecuta con su propio Node 20, sin instalar nada.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'streamdeck');
const UUID = 'com.kopernico.gameshow';
const OUT_DIR = path.join(REPO, 'tmp', 'streamdeck', UUID + '.sdPlugin');
const DEST = path.join(REPO, 'public', 'descargas', 'GameShow.streamDeckPlugin');
const VERSION = '1.0.1.0'; // subirla en cada cambio: el programa Stream Deck lo ve como actualización y el panel avisa

// Huella de todo lo que entra en el complemento (la prueba avisa si el archivo descargable está viejo)
function sourcesHash() {
    const h = crypto.createHash('sha256');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); });
    walk(SRC);
    files.push(__filename);
    files.push(path.join(REPO, 'public', 'shared', 'next-step.js')); // reglas de «Siguiente paso» (compartidas)
    // Sin contar los saltos de línea (Git en Windows los puede guardar como CRLF)
    files.sort().forEach(f => { h.update(path.relative(REPO, f).replace(/\\/g, '/')); h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')); });
    return h.digest('hex').slice(0, 16);
}

// ── PNG mínimo (el icono del complemento tiene que ser PNG) ──
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
            const o = y * (size * 4 + 1) + 1 + x * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Logo: cuadrado redondeado turquesa con un pulsador (círculo) y un «play» blanco
function logo(x, y, s) {
    const u = x / s, v = y / s;
    const rr = 0.2, inset = Math.max(0, Math.max(Math.abs(u - 0.5) - (0.5 - rr), 0) ** 2 + Math.max(Math.abs(v - 0.5) - (0.5 - rr), 0) ** 2);
    const inSq = Math.sqrt(inset) <= rr;
    if (!inSq) return [0, 0, 0, 0];
    const d = Math.hypot(u - 0.5, v - 0.5);
    const ring = d > 0.3 && d < 0.36;
    // triángulo de play centrado
    const tx = u - 0.46, ty = v - 0.5;
    const tri = tx > -0.1 && tx < 0.16 && Math.abs(ty) < (0.16 - tx) * 0.62;
    if (ring || tri) return [255, 255, 255, 255];
    return [14, 116, 144, 255];
}

async function bundle() {
    const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));
    await esbuild.build({
        entryPoints: [path.join(SRC, 'src', 'plugin.js')], bundle: true, platform: 'node', target: 'node20', format: 'cjs',
        outfile: path.join(OUT_DIR, 'bin', 'plugin.js'), external: ['bufferutil', 'utf-8-validate'], logLevel: 'warning',
        legalComments: 'none', define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
    });
}

function manifest(ACTIONS) {
    return {
        Name: 'GameShow', Version: VERSION, Author: 'Kopérnico', UUID,
        Description: 'Maneja GameShow (preguntas, pulsador, crono, rondas, pantalla de sala y música) desde el Stream Deck.',
        Icon: 'imgs/plugin', Category: 'GameShow', CategoryIcon: 'imgs/category',
        CodePath: 'bin/plugin.js', Nodejs: { Version: '20' }, SDKVersion: 2,
        Software: { MinimumVersion: '6.5' },
        OS: [{ Platform: 'windows', MinimumVersion: '10' }, { Platform: 'mac', MinimumVersion: '12' }],
        PropertyInspectorPath: 'pi/index.html',
        Actions: Object.entries(ACTIONS).map(([uuid, a]) => {
            const o = { UUID: uuid, Name: a.name, Icon: 'imgs/actions/' + a.id, Tooltip: a.tip || a.name, UserTitleEnabled: false,
                States: [{ Image: 'imgs/key', ShowTitle: false }] };
            if (a.kind === 'dial') {
                o.Controllers = ['Encoder'];
                o.Encoder = { layout: a.layout, Icon: 'imgs/actions/' + a.id,
                    TriggerDescription: { Rotate: a.trigger.rotate, Push: a.trigger.push, Touch: a.trigger.touch } };
            } else { o.Controllers = ['Keypad']; o.SupportedInMultiActions = true; }
            return o;
        }),
    };
}

async function build() {
    // Las acciones se leen de las fuentes (sin caché: se puede llamar varias veces)
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(SRC, 'src'))) delete require.cache[k];
    const { ACTIONS } = require(path.join(SRC, 'src', 'actions.js'));
    const { actionIconSvg } = require(path.join(SRC, 'src', 'draw.js'));
    fs.rmSync(path.dirname(OUT_DIR), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT_DIR, 'imgs', 'actions'), { recursive: true });
    fs.mkdirSync(path.join(OUT_DIR, 'pi'), { recursive: true });
    await bundle();
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest(ACTIONS), null, 2));
    fs.copyFileSync(path.join(SRC, 'pi', 'index.html'), path.join(OUT_DIR, 'pi', 'index.html'));
    for (const a of Object.values(ACTIONS)) fs.writeFileSync(path.join(OUT_DIR, 'imgs', 'actions', a.id + '.svg'), actionIconSvg(a.icon));
    fs.writeFileSync(path.join(OUT_DIR, 'imgs', 'category.svg'), actionIconSvg('next'));
    // Imagen por defecto de las teclas (el complemento la cambia en cuanto se conecta)
    fs.writeFileSync(path.join(OUT_DIR, 'imgs', 'key.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="18" fill="#1b1d2a"/><text x="72" y="82" text-anchor="middle" font-family="Segoe UI, Arial" font-size="22" font-weight="700" fill="#7c7f93">GameShow</text></svg>');
    fs.writeFileSync(path.join(OUT_DIR, 'imgs', 'plugin.png'), png(256, logo));
    fs.writeFileSync(path.join(OUT_DIR, 'imgs', 'plugin@2x.png'), png(512, logo));

    // Zip con la carpeta dentro (así lo espera el programa Stream Deck)
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    const archiver = require(path.join(REPO, 'node_modules', 'archiver'));
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(DEST);
        const zip = archiver('zip', { zlib: { level: 9 } });
        out.on('close', resolve); zip.on('error', reject);
        zip.pipe(out);
        zip.directory(OUT_DIR, UUID + '.sdPlugin');
        zip.finalize();
    });
    const info = { version: VERSION, hash: sourcesHash(), size: fs.statSync(DEST).size, actions: Object.keys(ACTIONS).length };
    fs.writeFileSync(DEST + '.json', JSON.stringify(info, null, 2) + '\n');
    return { dest: DEST, dir: OUT_DIR, ...info };
}

module.exports = { build, sourcesHash, DEST, OUT_DIR };

if (require.main === module) {
    build().then(r => console.log(`Complemento Stream Deck → ${path.relative(REPO, r.dest)} (${Math.round(r.size / 1024)} KB, ${r.actions} acciones, huella ${r.hash})`))
        .catch(e => { console.error(e); process.exit(1); });
}
