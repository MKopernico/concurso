// Sesión de staff en backoffice y coordinador:
// - si la API responde 401 (sesión caducada) → vuelve al login y luego a esta misma página
// - mantiene la sesión viva mientras la página esté abierta (la cookie se renueva en el servidor)
// - logout()
(function() {
    function goLogin() {
        location.replace('/login/?next=' + encodeURIComponent(location.pathname + location.search));
    }

    var _fetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        return _fetch(input, init).then(function(res) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1) goLogin();
            return res;
        });
    };

    function ping() {
        _fetch('/api/auth/me', { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(d) { if (!d.staff) goLogin(); })
            .catch(function() {}); // sin red: no expulsar, se reintenta en el siguiente ciclo
    }
    setInterval(ping, 20 * 60 * 1000);

    window.GSStaff = {
        goLogin: goLogin,
        // Si el servidor rechaza una orden de coordinador por falta de sesión
        watchSocket: function(socket) {
            socket.on('auth_required', function() {
                // La conexión se abrió con una cookie que ya no vale (p. ej. tras 12 h renovando la
                // sesión por HTTP). Si la sesión sigue viva, basta con reconectar; si no, al login.
                _fetch('/api/auth/me', { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.staff) { socket.disconnect(); socket.connect(); } else goLogin();
                }).catch(function() {});
            });
        },
        logout: function() {
            _fetch('/api/auth/logout', { method: 'POST' }).finally(function() { location.replace('/login/'); });
        },
    };
})();
