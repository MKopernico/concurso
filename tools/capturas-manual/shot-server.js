// Servidor solo para las capturas del manual: copia limpia de la BD y las subidas, puerto 3101,
// contraseña de prueba propia. Uso: node shot-server.js  (borra y rehace su copia al arrancar)
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const DATA = path.join(require('os').tmpdir(), 'gameshow-capturas-datos');
process.chdir(REPO);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const D = require(path.join(REPO, 'node_modules/better-sqlite3'));
const src = new D(path.join(REPO, 'db/games.db'), { readonly: true });
fs.cpSync(path.join(REPO, 'uploads'), path.join(DATA, 'uploads'), { recursive: true });
// Las dos imágenes que faltan en «Batidora genérica»: una copia de otra para que no salgan avisos
const imgs = path.join(DATA, 'uploads/images');
const any = fs.readdirSync(imgs).find(f => /\.jpe?g$/i.test(f));
if (any) for (const f of ['fondo.jpg', '1779311965224_9c1c8201.jpg']) fs.copyFileSync(path.join(imgs, any), path.join(imgs, f));
src.backup(path.join(DATA, 'games.db')).then(() => {
    src.close();
    // Sin partida guardada: se empieza de cero (equipos y puntos los pone el guion de capturas)
    const db = new D(path.join(DATA, 'games.db'));
    try { db.prepare('DELETE FROM sessions').run(); } catch (e) {}
    try { db.prepare('DELETE FROM teams').run(); } catch (e) {}
    // Solo los juegos que salen en el manual (fuera los de pruebas internas)
    const keep = ['g_1b469686', 'g_599ed307', 'g_8f91f28c'];
    const ph = keep.map(() => '?').join(',');
    db.prepare(`DELETE FROM questions WHERE round_id IN (SELECT id FROM rounds WHERE game_id NOT IN (${ph}))`).run(...keep);
    db.prepare(`DELETE FROM rounds WHERE game_id NOT IN (${ph})`).run(...keep);
    db.prepare(`DELETE FROM games WHERE id NOT IN (${ph})`).run(...keep);
    db.prepare(`UPDATE games SET name = 'Imagen que se aclara (prueba)', status = 'published', access_code = '1234' WHERE id = 'g_8f91f28c'`).run();
    db.prepare(`UPDATE games SET date = '2026-10-24', note = 'Plantilla general con todas las pruebas' WHERE id = 'g_1b469686'`).run();
    // Pregunta de pulsador con un contenido más vistoso para el manual
    db.prepare(`UPDATE questions SET content = ? WHERE id = (SELECT id FROM questions WHERE round_id = 'r_d5eead80' ORDER BY sort_order LIMIT 1)`)
        .run(JSON.stringify({ statement: '¿Cuál es el planeta más grande del sistema solar?', answer: 'Júpiter', hints: ['Es un gigante gaseoso'] }));
    // El juego por defecto (heredado) no sale en el manual
    db.prepare(`UPDATE games SET status = 'archived' WHERE id = 'default'`).run();
    db.close();
    process.env.PORT = '3101';
    process.env.GAMESHOW_DATA_DIR = DATA;
    process.env.ADMIN_PASSWORD = 'capturas-manual-local';
    require(path.join(REPO, 'server.js'));
});
