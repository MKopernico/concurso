// Monta el kit offline de GameShow para Windows. Lo usan tools/build-kit.js (carpeta en este PC)
// y routes/kit.js (zip descargable desde el backoffice, generado en Render).
//
// Estructura del kit (en carpeta o dentro del zip, bajo GameShow-Offline/):
//   ARRANCAR.bat · LEEME.txt · VERSION.txt
//   node/node.exe              → Node portátil de Windows (KIT_NODE)
//   app/server.js              → toda la app empaquetada en un solo archivo (esbuild)
//   app/kit/start.js · net.js  → arranque del kit
//   app/public/ · db/schema.sql · node_modules/socket.io/client-dist/  → archivos que se leen en marcha
//   app/node_modules/better-sqlite3 (+ bindings, file-uri-to-path)   → módulo nativo, compilado para Windows
//
// Empaquetar importa: con node_modules completo eran ~4.300 archivos y Windows tardaba más de 3 min
// en descomprimir el zip. Así quedan unos 100.

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const REPO = path.resolve(__dirname, '..');
const KIT_NODE = { version: '24.14.0', abi: '137' }; // abi = process.versions.modules de esa versión
const ROOT = 'GameShow-Offline';

// Archivos de la app que se leen en marcha (no se pueden empaquetar)
const RUNTIME_DIRS = ['public', 'data', 'node_modules/socket.io/client-dist']; // data/: diccionario de Letras
const RUNTIME_FILES = ['db/schema.sql', 'kit/start.js', 'kit/net.js'];
// Módulo nativo: va tal cual, con lo justo para que require('better-sqlite3') lo encuentre
const NATIVE = [
    'node_modules/better-sqlite3/package.json',
    'node_modules/better-sqlite3/lib',
    'node_modules/bindings/package.json',
    'node_modules/bindings/bindings.js',
    'node_modules/file-uri-to-path/package.json',
    'node_modules/file-uri-to-path/index.js',
];
const SQLITE_NODE = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

function listFiles(rel) {
    const abs = path.join(REPO, rel);
    if (!fs.statSync(abs).isDirectory()) return [rel];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? listFiles(rel + '/' + e.name) : [rel + '/' + e.name]);
}

function sqliteVersion() {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules/better-sqlite3/package.json'), 'utf8')).version;
}

// ── Empaquetado ─────────────────────────────────────────────────────────────

// Cada módulo que use __dirname lo recibe apuntando a su carpeta original dentro de app/
// (p. ej. db/index.js → app/db, socket.io → app/node_modules/socket.io/dist), así que las
// rutas a archivos de RUNTIME_* siguen funcionando aunque todo el código esté en server.js.
const dirnamePlugin = {
    name: 'dirname-relativo',
    setup(build) {
        build.onLoad({ filter: /\.js$/ }, async (args) => {
            let contents = await fs.promises.readFile(args.path, 'utf8');
            if (/\b__dirname\b/.test(contents)) {
                const rel = path.relative(REPO, path.dirname(args.path)).split(path.sep).join('/');
                contents = contents.replace(/\b__dirname\b/g, `require("path").join(__dirname, ${JSON.stringify(rel)})`);
            }
            return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
        });
    },
};

async function bundleServer() {
    const esbuild = require('esbuild');
    const out = await esbuild.build({
        entryPoints: [path.join(REPO, 'server.js')],
        bundle: true,
        platform: 'node',
        target: 'node' + KIT_NODE.version.split('.')[0],
        format: 'cjs',
        write: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'silent',
        // nativo (va aparte) · opcionales de ws (se cargan en try/catch) · solo para montar el kit
        external: ['better-sqlite3', 'bufferutil', 'utf-8-validate', 'esbuild'],
        plugins: [dirnamePlugin],
    });
    return Buffer.from(out.outputFiles[0].contents);
}

// ── Binarios de Windows ─────────────────────────────────────────────────────

async function download(url, dest) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Descarga fallida (${res.status}): ${url}`);
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

// Extrae un archivo de un .tar.gz (formato ustar, el de los binarios de better-sqlite3)
function extractFromTarGz(tgz, endsWith) {
    const tar = zlib.gunzipSync(fs.readFileSync(tgz));
    for (let off = 0; off + 512 <= tar.length;) {
        const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
        if (!name) break;
        const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
        if (name.endsWith(endsWith)) return tar.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error('No se encontró ' + endsWith + ' en ' + path.basename(tgz));
}

// node.exe y better_sqlite3.node para Windows. Si este mismo proceso es el Node del kit en Windows,
// se usan los suyos; si no (Render), se descargan una vez y se guardan en cacheDir.
// GAMESHOW_KIT_DOWNLOAD=1 fuerza la descarga (para probar en Windows el camino de Render).
async function windowsBinaries(cacheDir, log = () => {}) {
    if (process.env.GAMESHOW_KIT_DOWNLOAD !== '1' && process.platform === 'win32' && process.arch === 'x64' && process.version === 'v' + KIT_NODE.version) {
        return { nodeExe: process.execPath, sqliteNode: path.join(REPO, SQLITE_NODE) };
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    const nodeExe = path.join(cacheDir, `node-v${KIT_NODE.version}-win-x64.exe`);
    if (!fs.existsSync(nodeExe)) {
        const base = `https://nodejs.org/dist/v${KIT_NODE.version}/`;
        log('Descargando node.exe ' + KIT_NODE.version + '…');
        const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
        const expected = (sums.match(/^([0-9a-f]{64})\s+win-x64\/node\.exe$/m) || [])[1];
        if (!expected) throw new Error('No se pudo leer la suma de control de node.exe');
        const tmp = nodeExe + '.dl';
        await download(base + 'win-x64/node.exe', tmp);
        if (await sha256(tmp) !== expected) { fs.rmSync(tmp, { force: true }); throw new Error('node.exe descargado no coincide con su suma de control'); }
        fs.renameSync(tmp, nodeExe);
    }
    const ver = sqliteVersion();
    const sqliteNode = path.join(cacheDir, `better_sqlite3-v${ver}-node-v${KIT_NODE.abi}-win32-x64.node`);
    if (!fs.existsSync(sqliteNode)) {
        log('Descargando better-sqlite3 ' + ver + ' para Windows…');
        const tgz = sqliteNode + '.tar.gz';
        await download(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${ver}/better-sqlite3-v${ver}-node-v${KIT_NODE.abi}-win32-x64.tar.gz`, tgz);
        const bin = extractFromTarGz(tgz, 'better_sqlite3.node');
        fs.rmSync(tgz, { force: true });
        if (bin.toString('latin1', 0, 2) !== 'MZ') throw new Error('better_sqlite3.node descargado no es un binario de Windows');
        fs.writeFileSync(sqliteNode, bin);
    }
    return { nodeExe, sqliteNode };
}

// ── Contenido del kit ───────────────────────────────────────────────────────

function toCrlf(text) { return text.replace(/\r?\n/g, '\r\n'); }

function commitInfo() {
    if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT.slice(0, 7);
    try {
        return require('child_process').execSync('git log -1 --format="%h · %ad · %s" --date=format:"%d/%m/%Y %H:%M"', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { return ''; }
}

// Lista de entradas del kit: { name (relativo a la raíz del kit), file | data }
async function kitEntries({ cacheDir, log = () => {} }) {
    const [server, bins] = await Promise.all([bundleServer(), windowsBinaries(cacheDir, log)]);
    const entries = [{ name: 'app/server.js', data: server }];
    for (const rel of [...RUNTIME_DIRS, ...RUNTIME_FILES, ...NATIVE].flatMap(listFiles)) {
        entries.push({ name: 'app/' + rel, file: path.join(REPO, rel) });
    }
    entries.push({ name: 'app/' + SQLITE_NODE, file: bins.sqliteNode });
    entries.push({ name: 'node/node.exe', file: bins.nodeExe });
    for (const f of ['ARRANCAR.bat', 'LEEME.txt']) {
        entries.push({ name: f, data: Buffer.from(toCrlf(fs.readFileSync(path.join(REPO, 'kit', f), 'utf8')), 'utf8') });
    }
    entries.push({ name: 'VERSION.txt', data: Buffer.from(toCrlf([
        'GameShow kit offline',
        'Generado: ' + new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
        'Versión del código: ' + (commitInfo() || 'desconocida'),
        'Node: v' + KIT_NODE.version,
        '',
    ].join('\n')), 'utf8') });
    return entries;
}

// Huella del contenido: si no cambia nada de lo que entra en el kit, se reutiliza el zip anterior
function kitFingerprint() {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify({ KIT_NODE, sqlite: sqliteVersion(), esbuild: require('esbuild/package.json').version }));
    const sources = new Set();
    for (const rel of [...RUNTIME_DIRS, ...RUNTIME_FILES, 'kit']) listFiles(rel).forEach(f => sources.add(f));
    // Código que acaba dentro de server.js: el de la app (los módulos de node_modules los fija package-lock)
    for (const rel of ['server.js', 'auth.js', 'paths.js', 'letras-dict.js', 'package-lock.json', 'db', 'routes', 'sockets']) listFiles(rel).forEach(f => sources.add(f));
    for (const rel of [...sources].sort()) { h.update(rel + '\0'); h.update(fs.readFileSync(path.join(REPO, rel))); }
    return h.digest('hex').slice(0, 16);
}

async function writeZip(entries, destZip) {
    const archiver = require('archiver');
    const tmp = destZip + '.part';
    const out = fs.createWriteStream(tmp);
    const zip = archiver('zip', { zlib: { level: 6 } });
    const done = new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject); zip.on('error', reject); });
    zip.pipe(out);
    const date = new Date();
    for (const e of entries) {
        const name = ROOT + '/' + e.name;
        if (e.data) zip.append(e.data, { name, date });
        else zip.file(e.file, { name, date });
    }
    await zip.finalize();
    await done;
    fs.renameSync(tmp, destZip);
}

// ── Añadir un archivo a un zip ya hecho ─────────────────────────────────────
// Para el «juego offline»: se copia el zip del kit byte a byte y se añade el .zip del juego sin
// comprimir (ya lo está). Así no se recomprime node.exe en cada descarga: tarda segundos.

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
})();

async function crc32File(file) {
    let crc = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
        if (zlib.crc32) { crc = zlib.crc32(chunk, crc); continue; }
        let c = ~crc;
        for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8);
        crc = ~c >>> 0;
    }
    return crc >>> 0;
}

function dosDateTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

// Lee el final del zip (EOCD): dónde empieza el índice central y cuántas entradas tiene
function readEocd(fd, size) {
    const len = Math.min(size, 65557);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    for (let i = len - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) !== 0x06054b50) continue;
        const eocd = { entries: buf.readUInt16LE(i + 10), cdSize: buf.readUInt32LE(i + 12), cdOffset: buf.readUInt32LE(i + 16) };
        if (eocd.entries === 0xFFFF || eocd.cdOffset === 0xFFFFFFFF) throw new Error('Zip64 no admitido');
        return eocd;
    }
    throw new Error('El zip del kit no es válido');
}

async function appendStoredFile(baseZip, entryName, srcFile, destZip) {
    const srcSize = fs.statSync(srcFile).size;
    const baseSize = fs.statSync(baseZip).size;
    if (srcSize + baseSize > 0xF0000000) throw new Error('El juego es demasiado grande para el kit (máx. ~3,7 GB)');
    const fd = fs.openSync(baseZip, 'r');
    let eocd;
    try { eocd = readEocd(fd, baseSize); } finally { fs.closeSync(fd); }

    const crc = await crc32File(srcFile);
    const name = Buffer.from(ROOT + '/' + entryName, 'utf8');
    const { time, date } = dosDateTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(srcSize, 18); local.writeUInt32LE(srcSize, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(srcSize, 20); central.writeUInt32LE(srcSize, 24); central.writeUInt16LE(name.length, 28);
    // extra, comentario, disco, atributos = 0 · desplazamiento de la cabecera local = donde empezaba el índice
    central.writeUInt32LE(eocd.cdOffset, 42);

    const newCdOffset = eocd.cdOffset + local.length + name.length + srcSize;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(eocd.entries + 1, 8); end.writeUInt16LE(eocd.entries + 1, 10);
    end.writeUInt32LE(eocd.cdSize + central.length + name.length, 12); end.writeUInt32LE(newCdOffset, 16);

    const tmp = destZip + '.part';
    const out = fs.createWriteStream(tmp);
    const write = (b) => new Promise((resolve, reject) => out.write(b, err => err ? reject(err) : resolve()));
    const copy = async (file, start, endIncl) => {
        for await (const chunk of fs.createReadStream(file, { start, end: endIncl, highWaterMark: 1 << 20 })) await write(chunk);
    };
    try {
        if (eocd.cdOffset > 0) await copy(baseZip, 0, eocd.cdOffset - 1);   // entradas del kit
        await write(local); await write(name);
        if (srcSize > 0) await copy(srcFile, 0, srcSize - 1);                 // el juego
        if (eocd.cdSize > 0) await copy(baseZip, eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1); // índice del kit
        await write(central); await write(name);
        await write(end);
        await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    } catch (err) {
        out.destroy();
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    fs.renameSync(tmp, destZip);
}

async function writeFolder(entries, destDir) {
    for (const e of entries) {
        const target = path.join(destDir, e.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (e.data) fs.writeFileSync(target, e.data);
        else fs.copyFileSync(e.file, target);
    }
}

module.exports = { KIT_NODE, ROOT, kitEntries, kitFingerprint, writeZip, writeFolder, appendStoredFile, windowsBinaries, bundleServer, defaultCacheDir: () => path.join(os.tmpdir(), 'gameshow-kit-cache') };
