// Monta (o actualiza) la carpeta del kit offline de GameShow.
//
//   node tools/build-kit.js [carpeta-destino]
//   node tools/build-kit.js --zip <archivo.zip>     (el mismo zip que se descarga desde el backoffice)
//
// Por defecto: ../GameShow-Offline (junto a la carpeta del repo).
// - app/ y node/ se reemplazan enteras (contenido en kit/assemble.js: app empaquetada en pocos archivos)
// - Si este Node es el del kit (KIT_NODE) en Windows, usa su node.exe y su better-sqlite3;
//   si no, los descarga (y los guarda en la carpeta temporal del sistema para la próxima vez).
// - NUNCA toca <destino>/datos (juegos, archivos y ajustes): actualizar el kit es seguro.

const path = require('path');
const fs = require('fs');
const assemble = require('../kit/assemble');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const log = (s) => console.log('  ' + s);

function dirSize(p) {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
    return total;
}

async function buildZip(zipFile) {
    const dest = path.resolve(zipFile);
    console.log('Kit offline (zip) → ' + dest);
    const entries = await assemble.kitEntries({ cacheDir: assemble.defaultCacheDir(), log });
    await assemble.writeZip(entries, dest);
    console.log(`  ${entries.length} archivos · ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);
}

async function buildFolder(destArg) {
    const DEST = path.resolve(destArg || path.join(REPO, '..', 'GameShow-Offline'));
    const APP = path.join(DEST, 'app');
    const NODE = path.join(DEST, 'node');
    console.log('Kit offline → ' + DEST);

    // Se prepara todo antes de tocar la carpeta (si falla una descarga, el kit queda como estaba)
    const entries = await assemble.kitEntries({ cacheDir: assemble.defaultCacheDir(), log });
    fs.mkdirSync(DEST, { recursive: true });

    // Si el kit está en marcha, Windows no deja tocar sus archivos: se comprueba moviendo app/ y node/
    // a un lado ANTES de borrar nada (si falla, el kit queda intacto).
    const moved = [];
    for (const dir of [APP, NODE]) {
        const old = dir + '.old';
        if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
        if (!fs.existsSync(dir)) continue;
        try { fs.renameSync(dir, old); moved.push(dir); }
        catch (e) {
            for (const d of moved) fs.renameSync(d + '.old', d);
            console.error('\nNo se puede actualizar: el kit parece estar en marcha (' + e.code + ').');
            console.error('Cierra GameShow (la ventana negra del kit) y vuelve a ejecutar este script.');
            process.exit(1);
        }
    }
    try { await assemble.writeFolder(entries, DEST); }
    catch (e) {
        for (const dir of [APP, NODE]) fs.rmSync(dir, { recursive: true, force: true });
        for (const d of moved) fs.renameSync(d + '.old', d);
        throw new Error(e.message + ' (se ha dejado el kit como estaba)');
    }
    for (const d of moved) fs.rmSync(d + '.old', { recursive: true, force: true });
    log(`app/ y node/ (${entries.length} archivos) · ARRANCAR.bat, LEEME.txt, VERSION.txt`);

    fs.mkdirSync(path.join(DEST, 'datos'), { recursive: true });
    log('datos/ ' + (fs.readdirSync(path.join(DEST, 'datos')).length ? '(conservada)' : '(nueva, vacía)'));
    console.log('Tamaño total: ' + (dirSize(DEST) / 1048576).toFixed(0) + ' MB');
}

(args[0] === '--zip' ? buildZip(args[1] || path.join(REPO, '..', 'GameShow-Offline.zip')) : buildFolder(args[0]))
    .catch(err => { console.error('\nError montando el kit: ' + err.message); process.exit(1); });
