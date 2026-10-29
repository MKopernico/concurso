// Conexión del complemento con el servidor de GameShow.
// 1) Conexión de control (con la clave): el servidor dice con qué juego está emparejado este Stream Deck.
// 2) Conexión al juego emparejado como un coordinador más: recibe el mismo estado que el
//    coordinador (game:director_sync) y manda las mismas órdenes (director:*).

const { EventEmitter } = require('events');
const { io } = require('socket.io-client');

// Órdenes ligadas a una pregunta: llevan {at, round} y el servidor descarta las que llegan tarde (doble toque)
const POSITIONAL = new Set(['director:next_question', 'director:next_with_premio', 'director:prev_question', 'director:finish_round',
    'director:mark_correct', 'director:mark_wrong', 'director:karaoke_award', 'director:abierta_show', 'director:abierta_open',
    'director:abierta_close', 'director:abierta_reveal', 'director:abierta_mark', 'director:pic_set_drawer', 'director:pic_start']);

class GameShow extends EventEmitter {
    constructor() {
        super();
        this.server = null; this.key = null;
        this.control = null; this.game = null; this.gameId = null;
        this.st = null; this.rounds = []; this.gameName = null; this.deckName = null;
        this.code = 'nokey'; // nokey | offline | badkey | unpaired | ok
    }
    configure(server, key) {
        server = String(server || '').trim().replace(/\/+$/, '');
        key = String(key || '').trim();
        if (server === this.server && key === this.key) return;
        this.server = server; this.key = key;
        this._closeAll();
        if (!server || !key) { this._set('nokey'); return; }
        this._set('offline');
        const opts = { transports: ['websocket'], auth: { deckKey: key }, reconnectionDelayMax: 5000 };
        this.control = io(server, { ...opts, query: { deck: 'control' } });
        this.control.on('deck:status', (s) => {
            if (!s || !s.ok) { this._set('badkey'); this._joinGame(null); return; }
            this.deckName = s.name || null;
            this.gameName = s.gameName || null;
            this._joinGame(s.gameId || null);
            // «Conectado» solo con la conexión del juego en marcha (tras reiniciar el servidor llega antes la de control)
            this._set(s.gameId ? (this.st && this.game && this.game.connected ? 'ok' : 'offline') : 'unpaired');
        });
        this.control.on('connect_error', () => { if (this.code !== 'badkey') this._set('offline'); });
        this.control.on('disconnect', () => { if (this.code !== 'badkey') this._set('offline'); });
    }
    _joinGame(gameId) {
        if (gameId === this.gameId && this.game) return;
        if (this.game) { this.game.removeAllListeners(); this.game.close(); this.game = null; }
        this.gameId = gameId; this.st = null; this.rounds = [];
        this.emit('change');
        if (!gameId) return;
        const g = io(this.server, { transports: ['websocket'], auth: { deckKey: this.key }, query: { gameId }, reconnectionDelayMax: 5000 });
        this.game = g;
        g.on('connect', () => { g.emit('director:join'); g.emit('director:deck_rounds'); });
        g.on('game:director_sync', (s) => { this.st = s; if (this.code !== 'ok') this._set('ok'); this.emit('change'); });
        g.on('game:timer_tick', (d) => {
            if (!this.st || !this.st.director || !d) return;
            this.st.director.timer.remaining = d.remaining; this.st.director.timer.total = d.total;
            this.emit('tick');
        });
        g.on('actualizar_pulsador_lista', (q) => { if (this.st) { this.st.colaPulsador = q || []; this.emit('change'); } });
        g.on('game:rounds_changed', () => g.emit('director:deck_rounds'));
        g.on('game:deck_rounds', (d) => { this.rounds = (d && d.rounds) || []; if (d && d.gameName) this.gameName = d.gameName; this.emit('change'); });
        g.on('auth_required', () => this._set('unpaired'));
        g.on('disconnect', () => { if (this.code === 'ok') this._set('offline'); });
    }
    send(ev, data) {
        if (!this.game || !this.game.connected || !this.st) return false;
        data = Object.assign({}, data || {});
        if (POSITIONAL.has(ev) && this.st.director) { data.at = this.st.director.currentQuestionIdx; data.round = this.st.director.currentRoundId; }
        this.game.emit(ev, data);
        return true;
    }
    _set(code) { if (this.code !== code) { this.code = code; this.emit('change'); } }
    _closeAll() {
        if (this.control) { this.control.removeAllListeners(); this.control.close(); this.control = null; }
        this._joinGame(null);
    }
    // Para la tecla «Estado» y el panel de ajustes
    summary() {
        const T = {
            nokey: ['Sin clave', 'Pon la clave'], offline: ['Sin conexión', 'Reintentando'], badkey: ['Clave no válida', 'Pide otra'],
            unpaired: ['Sin juego', 'Emparéjalo'], ok: ['Conectado', ''],
        };
        const [title, hint] = T[this.code] || T.offline;
        return { code: this.code, ok: this.code === 'ok', title, hint, gameName: this.gameName, deckName: this.deckName, server: this.server };
    }
    close() { this._closeAll(); }
}

module.exports = { GameShow, POSITIONAL };
