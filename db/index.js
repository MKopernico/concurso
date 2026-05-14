// SQLite singleton + helpers. better-sqlite3 es síncrono, así que las queries se usan directamente sin await.
// El fichero vive en /db/games.db (spec §10.2). El esquema se aplica idempotentemente en cada arranque.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DATA_DIR, 'games.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_GAME_ID = 'default';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');     // mejor concurrencia lecturas/escrituras
db.pragma('foreign_keys = ON');

// Aplicar esquema (idempotente: todas las CREATE llevan IF NOT EXISTS)
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

// Seed del juego "default" (retrocompat con el flujo legacy: el panel PIN del index.html lo usa transparentemente).
function ensureDefaultGame() {
    const existing = db.prepare('SELECT id FROM games WHERE id = ?').get(DEFAULT_GAME_ID);
    if (existing) return;
    db.prepare(`
        INSERT INTO games (id, name, status, note, access_code)
        VALUES (?, ?, 'published', 'Juego legacy auto-creado para el flujo PIN clásico', '0000')
    `).run(DEFAULT_GAME_ID, 'Juego por defecto');
}
ensureDefaultGame();

module.exports = {
    db,
    DEFAULT_GAME_ID,
};
