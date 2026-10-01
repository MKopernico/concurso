// Arranque del kit offline de GameShow (lo lanza ARRANCAR.bat con el node portátil del kit).
//
// Estructura del kit:
//   ARRANCAR.bat · LEEME.txt
//   node/node.exe        → Node portátil (misma versión con la que se preparó la app)
//   app/                 → la aplicación (se sustituye entera al actualizar el kit)
//   datos/               → juegos, archivos subidos y ajustes (NO se toca al actualizar)

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const readline = require('readline');
const { exec } = require('child_process');
const { localIps } = require('./net');

const APP_DIR = path.resolve(__dirname, '..');
const KIT_DIR = path.resolve(APP_DIR, '..');
const DATA_DIR = path.join(KIT_DIR, 'datos');
const SETTINGS = path.join(DATA_DIR, 'ajustes.env');

function line(s = '') { console.log(s); }

// Un solo lector con cola de líneas: no se pierde nada aunque lleguen varias de golpe
let _rl = null;
const _lines = [];
const _waiting = [];
function ask(q) {
    if (!_rl) {
        _rl = readline.createInterface({ input: process.stdin });
        _rl.on('line', l => { const w = _waiting.shift(); if (w) w(l.trim()); else _lines.push(l.trim()); });
        _rl.on('close', () => { _rl.closed = true; while (_waiting.length) _waiting.shift()(null); });
    }
    process.stdout.write(q);
    if (_lines.length) return Promise.resolve(_lines.shift());
    if (_rl.closed) return Promise.reject(new Error('No se pudo leer la contraseña'));
    return new Promise((resolve, reject) => _waiting.push(a => a === null ? reject(new Error('No se pudo leer la contraseña')) : resolve(a)));
}
function closeAsk() { if (_rl) { _rl.close(); _rl = null; } }

function readSettings() {
    const out = {};
    if (!fs.existsSync(SETTINGS)) return out;
    for (const l of fs.readFileSync(SETTINGS, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

function writeSettings(s) {
    const body = [
        '# Ajustes del kit offline de GameShow',
        '# ADMIN_PASSWORD: llave maestra para backoffice y coordinador (siempre funciona,',
        '#                 aunque se cambie la contraseña desde el backoffice)',
        '# PORT: puerto del servidor (3000 por defecto)',
        `ADMIN_PASSWORD=${s.ADMIN_PASSWORD}`,
        `PORT=${s.PORT || 3000}`,
        '',
    ].join('\r\n');
    fs.writeFileSync(SETTINGS, body, 'utf8');
}

function portFree(port) {
    return new Promise(resolve => {
        const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '0.0.0.0');
    });
}

function waitReady(port, tries = 50) {
    return new Promise((resolve, reject) => {
        const attempt = (n) => {
            http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1000 }, res => { res.resume(); resolve(); })
                .on('error', () => n > 0 ? setTimeout(() => attempt(n - 1), 200) : reject(new Error('El servidor no arrancó')));
        };
        attempt(tries);
    });
}

async function main() {
    line('==================================================');
    line('   GameShow · Kit offline');
    line('==================================================');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const settings = readSettings();
    if (!settings.ADMIN_PASSWORD) {
        line('');
        line('Primera vez: define la contraseña del backoffice y del coordinador.');
        line('(Mínimo 8 caracteres. Se guarda en datos\\ajustes.env)');
        let pw = '';
        while (pw.length < 8) {
            pw = await ask('Contraseña: ');
            if (pw.length < 8) line('  Demasiado corta, prueba otra vez.');
        }
        closeAsk();
        settings.ADMIN_PASSWORD = pw;
        writeSettings(settings);
        line('Contraseña guardada.');
    }
    const port = Number(settings.PORT) || 3000;

    if (!(await portFree(port))) {
        line('');
        line(`El puerto ${port} ya está en uso: probablemente GameShow ya está abierto en otra ventana.`);
        line('Ciérrala o cambia PORT en datos\\ajustes.env.');
        process.exitCode = 1;
        return;
    }

    process.env.GAMESHOW_DATA_DIR = DATA_DIR;
    process.env.GAMESHOW_KIT = '1';
    process.env.ADMIN_PASSWORD = settings.ADMIN_PASSWORD;
    process.env.PORT = String(port);
    process.chdir(APP_DIR);
    require(path.join(APP_DIR, 'server.js'));

    await waitReady(port);
    const ips = localIps();
    const main = ips[0];
    line('');
    line('==================================================');
    if (main) {
        line('  GameShow está funcionando.');
        line('');
        line(`  iPads (misma WiFi):  http://${main.ip}:${port}/play/`);
        line(`  Backoffice:          http://${main.ip}:${port}/admin/`);
        if (ips.length > 1) {
            line('');
            line('  Otras direcciones de este PC (si la de arriba no funciona):');
            ips.slice(1).forEach(i => line(`    http://${i.ip}:${port}/play/   (${i.name})`));
        }
    } else {
        line('  GameShow está funcionando, pero este PC no está conectado a ninguna red.');
        line('  Conéctalo a la WiFi del router y vuelve a arrancar para que entren los iPads.');
    }
    line('');
    line('  NO CIERRES ESTA VENTANA mientras dure el juego.');
    line('==================================================');
    line('');

    const url = `http://${main ? main.ip : 'localhost'}:${port}/kit/`;
    if (!process.env.GAMESHOW_NO_BROWSER) exec(`start "" "${url}"`);
}

main().catch(err => {
    console.error('');
    console.error('Error al arrancar GameShow:', err.message);
    process.exitCode = 1;
});
