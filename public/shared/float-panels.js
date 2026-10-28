// Paneles flotantes: un panel se saca a una ventana aparte («⧉ Ventana») y vuelve a su sitio con
// «📌 Anclar» o cerrando esa ventana. En Edge/Chrome la ventana se queda siempre encima de las demás
// (Document Picture-in-Picture); en otros navegadores de ordenador es una ventana emergente normal.
// En tablets no se ofrece. Se mueve el MISMO nodo, con sus eventos: el código que lo pinta sigue
// funcionando, porque document.getElementById también lo busca en la ventana flotante.
// Varios paneles comparten una sola ventana (el navegador solo deja una por página).
//
//   FloatPanels.setup(el, { title, size: { w, h }?, onFloat(el)?, onDock(el, byUser)?, onError()? })
//       añade el botón a la cabecera del panel (size: lo que pide la ventana; si no, lo que ocupa el panel)
//   FloatPanels.isFloating(el) · FloatPanels.dock(el) · FloatPanels.supported
(function () {
    var hasPip = 'documentPictureInPicture' in window;
    var finePointer = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
    var supported = hasPip || finePointer;
    var win = null, opening = false, floated = []; // { el, home (marcador de su sitio), opts }

    var gid = Document.prototype.getElementById;
    document.getElementById = function (id) {
        var el = gid.call(document, id);
        if (el || !win) return el;
        try { return gid.call(win.document, id); } catch (e) { return null; }
    };

    function find(el) {
        for (var i = 0; i < floated.length; i++) if (floated[i].el === el) return i;
        return -1;
    }
    function isFloating(el) { return find(el) >= 0; }

    function setTitle() {
        if (!win) return;
        win.document.title = 'GameShow · ' + floated.map(function (f) { return f.opts.title || 'Panel'; }).join(' + ');
    }
    function setLabel(el) {
        var b = el.querySelector('[data-float-btn]');
        if (!b) return;
        var on = isFloating(el);
        b.innerHTML = on ? '&#128204; Anclar' : '&#10697; Ventana';
        b.title = on ? 'Volver a ponerlo en el coordinador' : 'Sacarlo a una ventana aparte que se queda encima';
    }

    // Tamaño pedido: el que diga el panel o lo que ocupa ahora (con tope de pantalla)
    function wantSize(el, opts) {
        var maxW = (screen.availWidth || 1200) - 40, maxH = (screen.availHeight || 800) - 80;
        var s = opts && opts.size;
        var w = s && s.w ? s.w : Math.max(360, Math.min(520, el.offsetWidth + 24));
        var h = s && s.h ? s.h : Math.max(260, el.scrollHeight + 32);
        return { w: Math.round(Math.min(maxW, w)), h: Math.round(Math.min(maxH, h)) };
    }

    function openPopup(size) {
        var w = window.open('', 'gsFlotante', 'popup,width=' + size.w + ',height=' + size.h);
        return w ? Promise.resolve(w) : Promise.reject(new Error('blocked'));
    }
    function openWindow(size) {
        if (!hasPip) return openPopup(size);
        // Si la ventana que se queda encima falla, una emergente normal (solo en ordenador)
        return window.documentPictureInPicture.requestWindow({ width: size.w, height: size.h })
            .catch(function (e) { if (finePointer) return openPopup(size); throw e; });
    }

    function prepare(w) {
        var d = w.document;
        d.head.innerHTML = '';
        d.body.innerHTML = '';
        var meta = d.createElement('meta'); meta.setAttribute('charset', 'utf-8'); d.head.appendChild(meta);
        // Los mismos estilos que la página (copiados; los <link> con su dirección completa)
        document.querySelectorAll('style, link[rel="stylesheet"]').forEach(function (n) {
            var c = n.cloneNode(true);
            if (c.tagName === 'LINK') c.href = n.href;
            d.head.appendChild(c);
        });
        var st = d.createElement('style');
        // La ventana nueva va en «modo antiguo» (sin doctype): para que se pueda desplazar, quien
        // desplaza es la ventana (html) y el body no corta nada
        st.textContent = 'html { height: auto !important; overflow: auto !important; }'
            + ' body { height: auto !important; min-height: 0 !important; overflow: visible !important; display: block !important; padding: 8px; }';
        d.head.appendChild(st);
        d.body.className = 'gs-float';
        // Cerrar la ventana = anclar todo. Cerrar o recargar el coordinador = cerrar la ventana.
        w.addEventListener('pagehide', function () { if (win === w) dockAll(false); });
        win = w;
    }

    function moveIn(el, opts) {
        var home = document.createComment('panel flotante');
        el.parentNode.insertBefore(home, el);
        floated.push({ el: el, home: home, opts: opts });
        el.classList.add('floating', 'active');
        el.style.left = el.style.top = '';
        win.document.body.appendChild(el);
        setLabel(el);
        setTitle();
        if (opts.onFloat) opts.onFloat(el);
    }

    function float(el, opts) {
        if (isFloating(el) || opening) return;
        if (win) {
            // Ya hay ventana: se añade debajo y se agranda lo que se pueda
            var want = wantSize(el, opts);
            moveIn(el, opts);
            try { win.resizeTo(Math.max(win.outerWidth, want.w), Math.min((screen.availHeight || 800) - 40, win.outerHeight + want.h)); } catch (e) {}
            return;
        }
        opening = true;
        var size = wantSize(el, opts);
        openWindow(size).then(function (w) {
            opening = false;
            prepare(w);
            moveIn(el, opts);
            // El navegador puede abrirla más pequeña de lo pedido: se intenta agrandar (si no deja, se queda así)
            try { if (w.innerWidth < size.w - 20 || w.innerHeight < size.h - 20) w.resizeTo(size.w, size.h); } catch (e) {}
        }, function () {
            opening = false;
            if (opts.onError) opts.onError();
        });
    }

    function dock(el, byUser) {
        var i = find(el);
        if (i < 0) return;
        var f = floated.splice(i, 1)[0];
        f.el.classList.remove('floating', 'active');
        if (f.home.parentNode) { f.home.parentNode.insertBefore(f.el, f.home); f.home.remove(); }
        else document.body.appendChild(f.el);
        setLabel(f.el);
        setTitle();
        if (!floated.length && win) { var w = win; win = null; try { w.close(); } catch (e) {} }
        if (f.opts.onDock) f.opts.onDock(f.el, !!byUser);
    }
    function dockAll(byUser) {
        floated.slice().forEach(function (f) { dock(f.el, byUser); });
        win = null;
    }
    window.addEventListener('pagehide', function () {
        if (win) { var w = win; dockAll(false); try { w.close(); } catch (e) {} }
    });

    function setup(el, opts) {
        opts = opts || {};
        if (!supported || !el) return;
        var head = el.querySelector('.bl-header');
        if (!head) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bl-cancel bl-float-btn';
        b.setAttribute('data-float-btn', '');
        var close = head.querySelector('.bl-close');
        head.insertBefore(b, close || null);
        setLabel(el);
        b.addEventListener('click', function () {
            if (isFloating(el)) dock(el, true);
            else float(el, opts);
        });
    }

    window.FloatPanels = { setup: setup, isFloating: isFloating, dock: dock, supported: supported };
})();
