// «Imagen que se aclara»: dibuja la imagen pixelada o desenfocada según la nitidez (0 = irreconocible,
// 1 = nítida). Lo usan la pantalla y el coordinador. El desenfoque se hace igual que el pixelado
// (reducir y ampliar) pero suavizando, así se ve igual en todos los navegadores, también en iPad.
(function (root) {
    function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
    // Resolución horizontal de la imagen reducida: de muy pocos puntos a casi la real, en escala
    // geométrica para que el avance se note parecido al principio y al final.
    function detail(effect, level) {
        var min = effect === 'blur' ? 3 : 5, max = effect === 'blur' ? 260 : 220;
        return Math.round(min * Math.pow(max / min, clamp(level)));
    }

    function draw(canvas, img, effect, level) {
        if (!canvas || !img || !img.naturalWidth) return;
        var dpr = Math.min(2, root.devicePixelRatio || 1);
        var W = Math.max(1, Math.round(canvas.clientWidth * dpr)), H = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        var s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
        var dw = Math.max(1, Math.round(img.naturalWidth * s)), dh = Math.max(1, Math.round(img.naturalHeight * s));
        var dx = Math.round((W - dw) / 2), dy = Math.round((H - dh) / 2);
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        level = clamp(level);
        var sw = detail(effect, level);
        if (level >= 1 || sw >= dw) { ctx.imageSmoothingEnabled = true; ctx.drawImage(img, dx, dy, dw, dh); return; }
        var sh = Math.max(1, Math.round(sw * dh / dw));
        var off = draw._off || (draw._off = document.createElement('canvas'));
        off.width = sw; off.height = sh;
        var o = off.getContext('2d');
        o.imageSmoothingEnabled = true;
        if (o.imageSmoothingQuality) o.imageSmoothingQuality = 'high';
        o.drawImage(img, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = effect === 'blur';
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(off, 0, 0, sw, sh, dx, dy, dw, dh);
    }

    // Animador: recibe el estado del servidor ({ level, running, rate }) y lo hace avanzar
    // localmente desde el momento en que llega (sin depender del reloj de cada dispositivo).
    function Player(canvas) {
        this.canvas = canvas; this.img = null; this.src = null; this.effect = 'pixel';
        this.base = 0; this.rate = 0; this.t0 = 0; this.raf = 0; this.onLevel = null;
        var self = this;
        root.addEventListener('resize', function () { self.paint(); });
    }
    Player.prototype.level = function () {
        var dt = (performance.now() - this.t0) / 1000;
        return clamp(this.base + this.rate * dt);
    };
    Player.prototype.set = function (src, effect, st) {
        var self = this;
        this.effect = effect === 'blur' ? 'blur' : 'pixel';
        st = st || { level: 0, running: false, rate: 0 };
        this.base = clamp(st.level); this.rate = st.running ? (Number(st.rate) || 0) : 0; this.t0 = performance.now();
        if (src !== this.src) {
            this.src = src; this.img = null;
            if (src) {
                var im = new Image();
                im.onload = function () { if (self.src === src) { self.img = im; self.paint(); } };
                im.src = src;
            }
        }
        this.loop();
    };
    Player.prototype.paint = function () {
        var lvl = this.level();
        draw(this.canvas, this.img, this.effect, lvl);
        if (this.onLevel) this.onLevel(lvl);
        return lvl;
    };
    Player.prototype.loop = function () {
        var self = this;
        cancelAnimationFrame(this.raf);
        var lvl = this.paint();
        if (this.rate > 0 && lvl < 1) this.raf = requestAnimationFrame(function () { self.loop(); });
    };
    Player.prototype.stop = function () { cancelAnimationFrame(this.raf); this.rate = 0; };

    root.AclaraFX = { draw: draw, Player: Player };
})(window);
