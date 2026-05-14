// GameShow — entry point.
// Express sirve estáticos (/, /play, /director, /screen, /admin) + API REST en /api.
// Socket.io aísla cada juego en una room `game:<gameId>` (spec §7.3, §10.4).
// La lógica de tiempo real (pulsador, precio justo, bloqueos, bonos, escenas) está en sockets/game.js.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

require('./db'); // arranca la BD e inserta el juego 'default' si no existe (efecto colateral)
const apiRoutes = require('./routes/games');
const uploadRoutes = require('./routes/uploads');
const { attachSocketHandlers } = require('./sockets/game');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '2mb' }));

// API REST (CRUD de juegos/rondas/preguntas + uploads — spec §10.3)
app.use('/api', apiRoutes);
app.use('/api', uploadRoutes);

// Health-check para keepalive en Render (los WebSockets no cuentan como tráfico HTTP).
app.get('/ping', (req, res) => res.send('ok'));

// Vistas estáticas. Cada rol tiene su carpeta (spec §10.2).
// El monolítico legacy sigue en /public para no perder funcionalidad.
app.use('/play',     express.static(path.join(__dirname, 'public', 'play')));
app.use('/director', express.static(path.join(__dirname, 'public', 'director')));
// Catch-all: /director/:gameId sirve el mismo index.html (el client extrae gameId de la URL).
app.get('/director/:gameId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'director', 'index.html'));
});
app.use('/screen',   express.static(path.join(__dirname, 'public', 'screen')));
app.get('/screen/:gameId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'screen', 'index.html'));
});
app.use('/admin',    express.static(path.join(__dirname, 'public', 'admin')));
app.use('/shared',   express.static(path.join(__dirname, 'public', 'shared')));
app.use('/uploads',  express.static(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'))); // legacy `/` y assets sueltos (espera.jpg, etc.)

// Handlers de Socket.io (los listeners se enganchan al objeto io una sola vez al arrancar).
attachSocketHandlers(io);

// Arranque robusto: si el puerto está ocupado, abortar limpio (Render reintenta).
const port = process.env.PORT || 3000;
const listener = server.listen(port, '0.0.0.0', () => {
    console.log('🚀 GameShow ON · puerto', listener.address().port);
});
listener.on('error', (e) => {
    if (e.code === 'EADDRINUSE') process.exit(1);
    throw e;
});
