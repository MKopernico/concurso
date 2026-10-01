// Dónde viven los datos (BD + archivos subidos):
// - GAMESHOW_DATA_DIR (kit offline: carpeta "datos" junto a la app, sobrevive a actualizaciones)
// - /data en Render (disco persistente)
// - si no, dentro del propio repo (desarrollo local)

const path = require('path');
const fs = require('fs');

let DB_DIR, UPLOADS_DIR;
if (process.env.GAMESHOW_DATA_DIR) {
    const base = path.resolve(process.env.GAMESHOW_DATA_DIR);
    DB_DIR = base;
    UPLOADS_DIR = path.join(base, 'uploads');
} else if (fs.existsSync('/data')) {
    DB_DIR = '/data';
    UPLOADS_DIR = '/data/uploads';
} else {
    DB_DIR = path.join(__dirname, 'db');
    UPLOADS_DIR = path.join(__dirname, 'uploads');
}
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

module.exports = { DB_DIR, UPLOADS_DIR };
