// Pictionary: pizarra compartida.
// - PicBoard.Board(contenedor): dibuja los trazos en un lienzo 4:3 blanco que se ajusta al contenedor.
//   Coordenadas en enteros 0-10000 (iguales en el iPad que dibuja, la pantalla y el coordinador).
// - PicBoard.Viewer(board, socket): mantiene la pizarra al día con lo que manda el servidor
//   (pic:chunk / pic:op / pic:full). Si se pierde un trozo (número de secuencia que no cuadra), pide
//   el dibujo entero.
// - PicBoard.Pad(board, barra, opciones): convierte la pizarra en superficie de dibujo (dedo o
//   Apple Pencil) con su barra de herramientas. Pinta al momento y envía los trazos en trozos cada 40 ms.
(function (root) {
    'use strict';

    var COLORS = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#8b5a2b'];
    var COLOR_NAMES = ['Negro', 'Rojo', 'Azul', 'Verde', 'Amarillo', 'Morado', 'Marrón'];
    var ERASER = 9;                         // «color» de la goma (pinta de blanco)
    var WIDTHS = [0.005, 0.011, 0.024];     // grosor del lápiz, en fracción del ancho de la pizarra
    var ERASER_WIDTHS = [0.025, 0.05, 0.1];
    var SCALE = 10000;

    function strokeColor(c) { return c === ERASER ? '#ffffff' : (COLORS[c] || COLORS[0]); }
    function strokeWidth(st, W) { return (st.c === ERASER ? ERASER_WIDTHS : WIDTHS)[st.w] * W || 2; }

    // ───────────────── Pizarra ─────────────────
    function Board(container) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'pic-canvas';
        container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this.strokes = [];
        this.W = 0; this.H = 0;
        var self = this;
        this._fit = function () { self.fit(); };
        if (window.ResizeObserver) { this._ro = new ResizeObserver(this._fit); this._ro.observe(container); }
        window.addEventListener('resize', this._fit);
        window.addEventListener('orientationchange', this._fit);
        this.fit();
    }
    // Ajusta el lienzo (4:3) al hueco del contenedor, con la resolución real de la pantalla
    Board.prototype.fit = function () {
        var cw = this.container.clientWidth, ch = this.container.clientHeight;
        if (!cw || !ch) return;
        var w = Math.min(cw, ch * 4 / 3), h = w * 3 / 4;
        w = Math.floor(w); h = Math.floor(h);
        var dpr = Math.min(2.5, window.devicePixelRatio || 1);
        var cs = this.canvas.style;
        if (cs.width !== w + 'px' || cs.height !== h + 'px' || this._dpr !== dpr) {
            cs.width = w + 'px'; cs.height = h + 'px';
            this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
            this._dpr = dpr;
            this.W = this.canvas.width; this.H = this.canvas.height;
            this.render();
        }
    };
    Board.prototype.render = function () {
        var ctx = this.ctx;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, this.W, this.H);
        for (var i = 0; i < this.strokes.length; i++) this.drawFrom(this.strokes[i], 0);
    };
    // Pinta un trazo desde el punto «from» (para ir añadiendo sin repintar todo)
    Board.prototype.drawFrom = function (st, from) {
        var p = st.p, n = p.length / 2;
        if (!n || !this.W) return;
        var ctx = this.ctx, sx = this.W / SCALE, sy = this.H / SCALE;
        var lw = strokeWidth(st, this.W);
        ctx.strokeStyle = ctx.fillStyle = strokeColor(st.c);
        ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (n === 1) {
            ctx.beginPath(); ctx.arc(p[0] * sx, p[1] * sy, lw / 2, 0, Math.PI * 2); ctx.fill();
            return;
        }
        var i = Math.max(1, from);
        ctx.beginPath();
        ctx.moveTo(p[(i - 1) * 2] * sx, p[(i - 1) * 2 + 1] * sy);
        for (; i < n; i++) ctx.lineTo(p[i * 2] * sx, p[i * 2 + 1] * sy);
        ctx.stroke();
    };
    Board.prototype.setStrokes = function (list) {
        this.strokes = (list || []).map(function (s) { return { s: s.s, c: s.c, w: s.w, p: s.p.slice() }; });
        this.render();
    };
    // Trozo de trazo: { s, n (nuevo), c, w, p }
    Board.prototype.addChunk = function (d) {
        var st = this.strokes[this.strokes.length - 1];
        if (d.n || !st || st.s !== d.s) { st = { s: d.s, c: d.c, w: d.w, p: [] }; this.strokes.push(st); }
        var from = st.p.length / 2;
        for (var i = 0; i < d.p.length; i++) st.p.push(d.p[i]);
        this.drawFrom(st, from);
    };
    Board.prototype.undo = function () { this.strokes.pop(); this.render(); };
    Board.prototype.clear = function () { this.strokes = []; this.render(); };
    Board.prototype.destroy = function () {
        if (this._ro) this._ro.disconnect();
        window.removeEventListener('resize', this._fit);
        window.removeEventListener('orientationchange', this._fit);
        if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    };

    // ───────────────── Vista en directo ─────────────────
    // setKey(clave de la pregunta): al cambiar de pregunta se vacía y se pide el dibujo entero.
    function Viewer(board, socket) {
        this.board = board; this.socket = socket;
        this.key = null; this.seq = 0;
        var self = this;
        socket.on('pic:chunk', function (d) {
            if (!d || d.k !== self.key) return;
            if (d.q !== self.seq + 1) { self.request(); return; }
            self.seq = d.q;
            self.board.addChunk(d);
        });
        socket.on('pic:op', function (d) {
            if (!d || d.k !== self.key) return;
            if (d.q !== self.seq + 1) { self.request(); return; }
            self.seq = d.q;
            if (d.op === 'undo') self.board.undo(); else if (d.op === 'clear') self.board.clear();
        });
        socket.on('pic:full', function (d) {
            if (!d || d.k !== self.key) return;
            self._asked = 0;
            self.seq = d.q || 0;
            self.board.setStrokes(d.strokes || []);
        });
        socket.on('connect', function () { if (self.key) self.request(true); });
    }
    Viewer.prototype.setKey = function (key) {
        if (key === this.key) return;
        this.key = key; this.seq = 0;
        this.board.clear();
        if (key) this.request(true);
    };
    // Pide el dibujo entero (como mucho una vez cada 1,5 s si llegan varios trozos descolocados)
    Viewer.prototype.request = function (force) {
        var now = Date.now();
        if (!force && this._asked && now - this._asked < 1500) return;
        this._asked = now;
        if (this.socket.connected) this.socket.emit('pic:get');
    };

    // ───────────────── Dibujar ─────────────────
    // opts: { emit(evento, datos), getKey() } — getKey da la pregunta en curso (los trazos la llevan)
    function Pad(board, bar, opts) {
        this.board = board; this.bar = bar; this.opts = opts;
        this.color = 0; this.width = 1; this.eraser = false;
        this.penOnly = false; this.penSeen = false;
        this.active = null;       // { id (puntero), st (trazo), sent (puntos ya enviados) }
        this.enabled = true;
        this.nextId = 1;
        this._timer = null;
        this._buildBar();
        this._bind();
    }
    Pad.prototype._buildBar = function () {
        var html = '<div class="pic-tools-group pic-colors">';
        for (var i = 0; i < COLORS.length; i++) {
            html += '<button type="button" class="pic-color" data-color="' + i + '" style="--sw:' + COLORS[i] + '" aria-label="' + COLOR_NAMES[i] + '"></button>';
        }
        html += '</div><div class="pic-tools-group pic-sizes">';
        for (var j = 0; j < 3; j++) html += '<button type="button" class="pic-size" data-size="' + j + '" aria-label="Grosor ' + (j + 1) + '"><span style="--d:' + [6, 12, 22][j] + 'px"></span></button>';
        html += '</div><div class="pic-tools-group pic-actions">'
            + '<button type="button" class="pic-btn pic-eraser" data-act="eraser">🧽<span>Goma</span></button>'
            + '<button type="button" class="pic-btn" data-act="undo">↶<span>Deshacer</span></button>'
            + '<button type="button" class="pic-btn pic-clear" data-act="clear">🗑<span>Borrar todo</span></button>'
            + '<button type="button" class="pic-btn pic-penonly" data-act="penonly" hidden>✍️<span>Solo lápiz</span></button>'
            + '</div>';
        this.bar.innerHTML = html;
        this._syncBar();
    };
    Pad.prototype._syncBar = function () {
        var self = this;
        this.bar.querySelectorAll('.pic-color').forEach(function (b) { b.classList.toggle('on', !self.eraser && +b.dataset.color === self.color); });
        this.bar.querySelectorAll('.pic-size').forEach(function (b) {
            b.classList.toggle('on', +b.dataset.size === self.width);
            b.querySelector('span').style.background = self.eraser ? '#9ca3af' : COLORS[self.color];
        });
        this.bar.querySelector('.pic-eraser').classList.toggle('on', this.eraser);
        var po = this.bar.querySelector('.pic-penonly');
        po.hidden = !this.penSeen;
        po.classList.toggle('on', this.penOnly);
    };
    Pad.prototype._bind = function () {
        var self = this, cv = this.board.canvas;
        // Barra: se actúa al apoyar el dedo (sin esperar al clic ni al doble toque de iOS)
        this.bar.addEventListener('pointerdown', function (e) {
            var b = e.target.closest('button');
            if (!b || !self.enabled) return;
            e.preventDefault();
            if (b.dataset.color !== undefined) { self.color = +b.dataset.color; self.eraser = false; }
            else if (b.dataset.size !== undefined) self.width = +b.dataset.size;
            else if (b.dataset.act === 'eraser') self.eraser = !self.eraser;
            else if (b.dataset.act === 'undo') self.undo();
            else if (b.dataset.act === 'penonly') self.penOnly = !self.penOnly;
            else if (b.dataset.act === 'clear') {
                // Borrar todo pide un segundo toque (3 s) para que no se pierda el dibujo sin querer
                if (b.classList.contains('confirm')) { b.classList.remove('confirm'); clearTimeout(self._clrT); self.clear(); }
                else {
                    b.classList.add('confirm'); b.querySelector('span').textContent = '¿Seguro? Toca otra vez';
                    clearTimeout(self._clrT);
                    self._clrT = setTimeout(function () { b.classList.remove('confirm'); b.querySelector('span').textContent = 'Borrar todo'; }, 3000);
                }
            }
            self._syncBar();
        });
        ['click', 'dblclick', 'contextmenu'].forEach(function (ev) { self.bar.addEventListener(ev, function (e) { e.preventDefault(); }); });

        cv.addEventListener('pointerdown', function (e) {
            if (!self.enabled) return;
            if (e.pointerType === 'pen' && !self.penSeen) { self.penSeen = true; self.penOnly = true; self._syncBar(); }
            if (self.penOnly && e.pointerType === 'touch') return; // palma de la mano con el Apple Pencil
            if (self.active) return;                                // un solo dedo/lápiz a la vez
            e.preventDefault();
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            self.flush();
            var st = { s: self.nextId++, c: self.eraser ? ERASER : self.color, w: self.width, p: [] };
            self.board.strokes.push(st);
            self.active = { id: e.pointerId, st: st, sent: 0 };
            self._addPoint(e);
            self._schedule();
        });
        cv.addEventListener('pointermove', function (e) {
            if (!self.active || e.pointerId !== self.active.id) return;
            e.preventDefault();
            var list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
            if (!list.length) list = [e];
            for (var i = 0; i < list.length; i++) self._addPoint(list[i]);
        });
        function end(e) {
            if (!self.active || e.pointerId !== self.active.id) return;
            self._addPoint(e);
            self.flush(true);
            self.active = null;
        }
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);
        ['touchstart', 'touchmove', 'gesturestart', 'contextmenu', 'dblclick'].forEach(function (ev) {
            cv.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
        });
    };
    Pad.prototype._addPoint = function (e) {
        var a = this.active; if (!a) return;
        var r = this.board.canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var x = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * SCALE);
        var y = Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * SCALE);
        var p = a.st.p, n = p.length;
        if (n && Math.abs(p[n - 2] - x) + Math.abs(p[n - 1] - y) < 12) return; // casi el mismo punto
        var from = n / 2;
        p.push(x, y);
        this.board.drawFrom(a.st, from);
    };
    Pad.prototype._schedule = function () {
        var self = this;
        if (this._timer) return;
        this._timer = setInterval(function () {
            self.flush();
            if (!self.active) { clearInterval(self._timer); self._timer = null; }
        }, 40);
    };
    // Envía lo que falte del trazo en curso (en trozos de como mucho 400 números)
    Pad.prototype.flush = function () {
        var a = this.active; if (!a) return;
        var p = a.st.p;
        while (a.sent < p.length) {
            var part = p.slice(a.sent, a.sent + 400);
            this.opts.emit('pic:stroke', { k: this.opts.getKey(), s: a.st.s, n: a.sent === 0, c: a.st.c, w: a.st.w, p: part });
            a.sent += part.length;
        }
    };
    Pad.prototype.undo = function () {
        if (this.active) return;
        if (!this.board.strokes.length) return;
        this.board.undo();
        this.opts.emit('pic:undo', { k: this.opts.getKey() });
    };
    Pad.prototype.clear = function () {
        if (this.active) return;
        this.board.clear();
        this.opts.emit('pic:clear', { k: this.opts.getKey() });
    };
    // Dibujo que guarda el servidor (al volver de un corte): sustituye al local
    Pad.prototype.load = function (strokes) {
        if (this.active) { this.flush(); this.active = null; }
        this.board.setStrokes(strokes);
        var max = 0;
        this.board.strokes.forEach(function (s) { if (s.s > max) max = s.s; });
        this.nextId = Math.max(this.nextId, max + 1);
    };
    Pad.prototype.setEnabled = function (on) {
        this.enabled = !!on;
        if (!on && this.active) { this.flush(); this.active = null; }
        this.bar.classList.toggle('disabled', !on);
    };

    root.PicBoard = { Board: Board, Viewer: Viewer, Pad: Pad, COLORS: COLORS, ERASER: ERASER };
})(typeof window !== 'undefined' ? window : this);
