// Login / logout / cambio de contraseña general (backoffice + coordinador).

const express = require('express');
const auth = require('../auth');

const router = express.Router();
const loginLimiter = auth.makeLimiter(10, 10 * 60 * 1000); // 10 fallos por IP cada 10 min

router.post('/auth/login', (req, res) => {
    if (!auth.isConfigured()) {
        return res.status(503).json({ error: 'No hay contraseña configurada en el servidor (variable ADMIN_PASSWORD).' });
    }
    const ip = req.ip;
    if (loginLimiter.blocked(ip)) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    }
    const { password } = req.body || {};
    if (!auth.verifyPassword(password)) {
        loginLimiter.fail(ip);
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    loginLimiter.reset(ip);
    auth.setSessionCookie(req, res);
    res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
    res.json({ staff: auth.isStaffRequest(req, res), configured: auth.isConfigured() });
});

router.put('/auth/password', (req, res) => {
    const { current, password } = req.body || {};
    if (!auth.verifyPassword(current)) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    auth.setPassword(password);
    auth.setSessionCookie(req, res); // esta sesión sigue abierta; las demás se cierran
    res.json({ ok: true });
});

module.exports = router;
