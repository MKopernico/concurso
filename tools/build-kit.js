// Monta (o actualiza) la carpeta del kit offline de GameShow.
//
//   node tools/build-kit.js [carpeta-destino]
//
// Por defecto: ../GameShow-Offline (junto a la carpeta del repo).
// - Copia la app (sin .git, .env, BD ni archivos de desarrollo) a <destino>/app
// - Copia este mismo node.exe a <destino>/node: better-sqlite3 está compilado para esta
//   versión de Node, así que hay que lanzar el script con el mismo Node del proyecto.
// - Escribe ARRANCAR.bat y LEEME.txt
// - NUNCA toca <destino>/datos (juegos, archivos y ajustes): actualizar el kit es seguro.

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const DEST = path.resolve(process.argv[2] || path.join(REPO, '..', 'GameShow-Offline'));
const APP = path.join(DEST, 'app');

const INCLUDE = ['server.js', 'auth.js', 'paths.js', 'package.json', 'db', 'routes', 'sockets', 'public', 'templates', 'kit', 'node_modules'];
// Dentro de lo incluido, no copiar datos de desarrollo
const SKIP = [/^db[\\/].*\.db(-wal|-shm)?$/i];

function dirSize(p) {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
    return total;
}

function toCrlf(text) { return text.replace(/\r?\n/g, '\r\n'); }

console.log('Kit offline → ' + DEST);
fs.mkdirSync(DEST, { recursive: true });

// 1. App (se reemplaza entera)
if (fs.existsSync(APP)) fs.rmSync(APP, { recursive: true, force: true });
for (const item of INCLUDE) {
    const src = path.join(REPO, item);
    if (!fs.existsSync(src)) { console.warn('  (no existe, se omite) ' + item); continue; }
    fs.cpSync(src, path.join(APP, item), {
        recursive: true,
        filter: (s) => !SKIP.some(re => re.test(path.relative(REPO, s))),
    });
}
console.log('  app/ copiada');

// 2. Node portátil (el mismo que ejecuta este script)
fs.mkdirSync(path.join(DEST, 'node'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(DEST, 'node', 'node.exe'));
console.log('  node/node.exe ' + process.version);

// 3. Lanzador e instrucciones
for (const f of ['ARRANCAR.bat', 'LEEME.txt']) {
    fs.writeFileSync(path.join(DEST, f), toCrlf(fs.readFileSync(path.join(REPO, 'kit', f), 'utf8')), 'utf8');
}
fs.writeFileSync(path.join(DEST, 'VERSION.txt'), toCrlf([
    'GameShow kit offline',
    'Generado: ' + new Date().toLocaleString('es-ES'),
    'Node: ' + process.version,
    '',
].join('\n')));
console.log('  ARRANCAR.bat, LEEME.txt, VERSION.txt');

fs.mkdirSync(path.join(DEST, 'datos'), { recursive: true });
console.log('  datos/ ' + (fs.readdirSync(path.join(DEST, 'datos')).length ? '(conservada)' : '(nueva, vacía)'));
console.log('Tamaño total: ' + (dirSize(DEST) / 1048576).toFixed(0) + ' MB');
