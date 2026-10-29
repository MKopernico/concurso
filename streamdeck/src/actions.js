// Catálogo de acciones del complemento: teclas (Keypad) y ruedas del Stream Deck + (Encoder).
// Cada acción dice cómo se ve (render) con el estado del juego y qué hace al pulsarla o girarla.
// ctx = { gs (conexión con GameShow), st (estado del coordinador), rounds, settings, mem (memoria de esa tecla) }

const { key, dialIcon } = require('./draw');
const { nextStep, nextRound } = require('./next-step');

const PREFIX = 'com.kopernico.gameshow.';
const TYPE_LABELS = {
    multirespuesta: 'Multirespuesta', pulsador: 'Pulsador', precio: 'Precio justo', imagen: 'Adivina imagen', cancion: 'Adivina canción',
    boom: 'Boom', ruleta: 'Ruleta', imagen_fija: 'Imagen fija', aclara: 'Imagen que se aclara', identidad: 'Identidad',
    abierta: 'Respuesta abierta', pictionary: 'Pictionary', cifras: 'Cifras', letras: 'Letras', karaoke: 'Karaoke',
};
const NO_TIMER = new Set(['pulsador', 'imagen', 'karaoke', 'ruleta', 'imagen_fija', 'cancion', 'aclara']);

const ds = (c) => (c.st && c.st.director) || null;
const inQuestion = (c) => { const d = ds(c); return !!d && (d.phase === 'question' || d.phase === 'answer_revealed'); };
const mmss = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
const cola = (c) => (c.st && c.st.colaPulsador) || [];

// Música: la fuente que esté puesta (propia o Spotify)
function music(c) {
    const d = ds(c), snd = d && d.sound;
    if (!snd) return null;
    const sp = (c.st && c.st.spotify) || {};
    const spotify = snd.source === 'spotify' && sp.enabled;
    const theme = (c.st && c.st.gameTheme) || {};
    const list = Array.isArray(theme.music) ? theme.music.filter(u => typeof u === 'string' && u) : [];
    if (spotify) {
        const p = sp.player;
        return { spotify: true, playing: !!((p && p.playing) || sp.held), track: p && p.track, vol: p && p.supportsVolume ? p.volume : null, snd, connected: !!sp.connected };
    }
    const idx = list.length ? snd.bg.idx % list.length : 0;
    return { spotify: false, playing: !!(snd.bg.playing && list.length), track: list.length ? soundName(list[idx]) : null, vol: snd.bgVol, snd, empty: !list.length };
}
function soundName(url) {
    let n = String(url || '').split('/').pop();
    try { n = decodeURIComponent(n); } catch (e) {}
    return n.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+$/, '').replace(/[_-]+/g, ' ').trim() || 'audio';
}
function musicToggle(c) {
    const m = music(c);
    if (!m) return false;
    if (m.spotify) c.gs.send('director:sound', { action: 'sp_toggle' });
    else c.gs.send('director:sound', { action: m.playing ? 'bg_pause' : 'bg_play' });
    return true;
}
function musicSkip(c, dir) {
    const m = music(c);
    if (!m) return false;
    c.gs.send('director:sound', { action: (m.spotify ? 'sp_' : 'bg_') + (dir > 0 ? 'next' : 'prev') });
    return true;
}
// Volumen: música (propia o Spotify) o sintonías. Devuelve false si no se puede.
function volumeOf(c, target) {
    const m = music(c);
    if (!m) return null;
    return target === 'jingle' ? m.snd.jingleVol : m.vol;
}
function setVolume(c, target, v) {
    const m = music(c);
    if (!m) return false;
    v = Math.max(0, Math.min(100, Math.round(v)));
    if (target === 'jingle') c.gs.send('director:sound', { action: 'set', jingleVol: v });
    else if (m.spotify) { if (m.vol === null) return false; c.gs.send('director:sound', { action: 'sp_vol', value: v }); }
    else c.gs.send('director:sound', { action: 'set', bgVol: v });
    return true;
}
// La ronda a la que apunta «Ronda» (siguiente de la escaleta o la nº N)
function targetRound(c) {
    const rounds = c.rounds || [];
    if (c.settings.mode === 'num') return rounds[(Number(c.settings.num) || 1) - 1] || null;
    const d = ds(c);
    return d ? nextRound(d, rounds) : null;
}
function typesOf(rounds) {
    const seen = [];
    (rounds || []).forEach(r => { if (!seen.includes(r.type)) seen.push(r.type); });
    return seen;
}

// ───────────────────────── Teclas ─────────────────────────
const K = {};

K['next-step'] = { name: 'Siguiente paso', icon: 'next', group: 'Juego', tip: 'Hace lo que toca ahora en la prueba (la tecla dice qué)',
    render: (c) => { const s = nextStep(c.st, c.rounds); return key({ icon: s.sub ? 'hand' : 'next', big: s.label, small: s.sub, tone: s.none ? 'warn' : 'accent' }); },
    key: (c) => { const s = nextStep(c.st, c.rounds); if (s.none) return false; c.gs.send(s.ev, s.data); return true; } };

K['q-next'] = { name: 'Pregunta siguiente', icon: 'chevR', group: 'Juego',
    render: (c) => { const d = ds(c); return key({ icon: 'chevR', big: inQuestion(c) ? (d.currentQuestionIdx + 1) + '/' + d.questions.length : 'Pregunta', small: 'Siguiente', tone: inQuestion(c) ? 'base' : 'off' }); },
    key: (c) => {
        const d = ds(c);
        if (!inQuestion(c) || d.currentQuestionIdx >= d.questions.length - 1) return false;
        const q = d.questions[d.currentQuestionIdx];
        if (q && q.config && q.config.premio) return false; // el bono se da en el coordinador (también al saltarla sin jugar)
        c.gs.send('director:next_question'); return true;
    } };

K['q-prev'] = { name: 'Pregunta anterior', icon: 'chevL', group: 'Juego',
    render: (c) => key({ icon: 'chevL', big: 'Anterior', tone: inQuestion(c) && ds(c).currentQuestionIdx > 0 ? 'base' : 'off' }),
    key: (c) => { if (!inQuestion(c) || ds(c).currentQuestionIdx <= 0) return false; c.gs.send('director:prev_question'); return true; } };

K['timer'] = { name: 'Crono', icon: 'clock', group: 'Juego', tip: 'Empezar o parar el tiempo',
    render: (c) => {
        const d = ds(c), t = d && d.timer;
        const type = d && d.currentRound && d.currentRound.type;
        if (!t || !inQuestion(c) || NO_TIMER.has(type)) return key({ icon: 'clock', big: 'Crono', small: 'Sin tiempo', tone: 'off' });
        return key({ icon: 'clock', big: mmss(t.remaining), small: t.running ? 'En marcha' : 'Parado', tone: t.running ? (t.remaining <= 5 ? 'warn' : 'on') : 'base', bar: t.total ? t.remaining / t.total : 0 });
    },
    key: (c) => { const d = ds(c); if (!inQuestion(c)) return false; c.gs.send(d.timer.running ? 'director:stop_timer' : 'director:start_timer'); return true; } };

K['timer-add'] = { name: 'Añadir tiempo', icon: 'plus', group: 'Juego', defaults: { seconds: 10 },
    render: (c) => { const s = Math.round(Number(c.settings.seconds) || 10); return key({ icon: 'plus', big: (s > 0 ? '+' : '') + s + ' s', tone: inQuestion(c) ? 'base' : 'off' }); },
    key: (c) => { if (!inQuestion(c)) return false; c.gs.send('director:extend_timer', { seconds: Math.round(Number(c.settings.seconds) || 10) }); return true; } };

K['buzzer'] = { name: 'Pulsador', icon: 'bell', group: 'Juego', tip: 'Abrir o cerrar el pulsador',
    render: (c) => key({ icon: 'bell', big: c.st && c.st.pulsadorActivo ? 'Abierto' : 'Cerrado', small: 'Pulsador', tone: c.st && c.st.pulsadorActivo ? 'on' : 'base' }),
    key: (c) => { if (!c.st) return false; c.gs.send(c.st.pulsadorActivo ? 'director:close_buzzer' : 'director:open_buzzer'); return true; } };

K['buzz-team'] = { name: 'Equipo que pulsó', icon: 'hand', group: 'Juego', tip: 'Enseña quién ha pulsado primero',
    render: (c) => { const q = cola(c); return q.length ? key({ icon: 'hand', big: q[0].nombre, small: q.length > 1 ? '+' + (q.length - 1) + ' en cola' : 'Ha pulsado', tone: 'blue' }) : key({ icon: 'hand', big: 'Nadie', small: 'Pulsador', tone: 'off' }); },
    key: () => false };

K['correct'] = { name: 'Correcto', icon: 'check', group: 'Juego', tip: 'El equipo que pulsó ha acertado',
    render: (c) => key({ icon: 'check', big: 'Correcto', small: cola(c)[0] ? cola(c)[0].nombre : '', tone: cola(c).length ? 'on' : 'off' }),
    key: (c) => { const q = cola(c); if (!q.length) return false; c.gs.send('director:mark_correct', { teamId: q[0].id }); return true; } };

K['wrong'] = { name: 'Fallo', icon: 'x', group: 'Juego', tip: 'El equipo que pulsó ha fallado',
    render: (c) => key({ icon: 'x', big: 'Fallo', small: cola(c)[0] ? cola(c)[0].nombre : '', tone: cola(c).length ? 'bad' : 'off' }),
    key: (c) => { const q = cola(c); if (!q.length) return false; c.gs.send('director:mark_wrong', { teamId: q[0].id }); return true; } };

K['reveal'] = { name: 'Mostrar respuesta', icon: 'eye', group: 'Juego',
    render: (c) => key({ icon: 'eye', big: 'Respuesta', tone: ds(c) && ds(c).phase === 'question' ? 'base' : 'off' }),
    key: (c) => { if (!ds(c) || ds(c).phase !== 'question') return false; c.gs.send('director:reveal_answer'); return true; } };

const screenKey = (name, icon, ev, isOn) => ({ name, icon, group: 'Pantalla de sala',
    render: (c) => key({ icon, big: name, tone: c.st && isOn(c) ? 'on' : 'base' }),
    key: (c) => { if (!c.st) return false; c.gs.send(ev); return true; } });
K['ranking'] = screenKey('Ranking', 'trophy', 'director:toggle_scoreboard', (c) => !!ds(c).scoreboardVisible);
K['waiting'] = screenKey('Espera', 'pause', 'director:show_waiting', (c) => ds(c).phase === 'waiting');
K['home'] = screenKey('Home', 'home', 'director:show_home', (c) => ds(c).phase === 'lobby');
K['qr'] = screenKey('QR', 'qr', 'director:toggle_qr', (c) => !!ds(c).qrVisible);
K['bono'] = screenKey('Anuncio de bono', 'gift', 'director:toggle_premio_anuncio', (c) => !!ds(c).premioAnuncioVisible);

K['round'] = { name: 'Ronda', icon: 'skipF', group: 'Juego', tip: 'Lanza la siguiente ronda o la nº N de la escaleta', defaults: { mode: 'next', num: 1 },
    render: (c) => {
        const r = targetRound(c), rounds = c.rounds || [];
        const n = r ? rounds.indexOf(r) + 1 : 0;
        return key({ icon: 'skipF', big: r ? 'Ronda ' + n + '/' + rounds.length : 'Ronda', small: r ? r.name : 'No queda', tone: r ? 'base' : 'off' });
    },
    key: (c) => { const r = targetRound(c); if (!r) return false; c.gs.send('director:launch_round', { roundId: r.id }); return true; } };

K['type'] = { name: 'Tipo de prueba', icon: 'grid', group: 'Juego', tip: 'Elige un tipo de prueba en el menú de la sala', defaults: { type: '' },
    render: (c) => { const t = c.settings.type || typesOf(c.rounds)[0]; return key({ icon: 'grid', big: TYPE_LABELS[t] || 'Tipo', small: 'Tipo de prueba', tone: t ? 'base' : 'off' }); },
    key: (c) => { const t = c.settings.type || typesOf(c.rounds)[0]; if (!t) return false; c.gs.send('director:select_category', { category: t }); return true; } };

K['music'] = { name: 'Música ▶/⏸', icon: 'play', group: 'Sonido',
    render: (c) => { const m = music(c); if (!m) return key({ icon: 'play', big: 'Música', tone: 'off' });
        return key({ icon: m.playing ? 'pause' : 'play', big: m.playing ? 'Sonando' : 'En pausa', small: m.track || (m.spotify ? 'Spotify' : 'Sin música'), tone: m.playing ? 'on' : 'base' }); },
    key: (c) => musicToggle(c) };
K['music-next'] = { name: 'Canción siguiente', icon: 'skipF', group: 'Sonido', render: (c) => key({ icon: 'skipF', big: 'Siguiente', small: 'Canción', tone: music(c) ? 'base' : 'off' }), key: (c) => musicSkip(c, 1) };
K['music-prev'] = { name: 'Canción anterior', icon: 'skipB', group: 'Sonido', render: (c) => key({ icon: 'skipB', big: 'Anterior', small: 'Canción', tone: music(c) ? 'base' : 'off' }), key: (c) => musicSkip(c, -1) };
K['jingle'] = { name: 'Sintonía', icon: 'music', group: 'Sonido', tip: 'Lanza la sintonía de la prueba en curso',
    render: (c) => { const j = ds(c) && ds(c).sound && ds(c).sound.jingle; return key({ icon: 'music', big: 'Sintonía', small: j ? 'Sonando' : '', tone: j ? 'on' : 'base' }); },
    key: (c) => { if (!ds(c)) return false; c.gs.send('director:sound', { action: 'jingle' }); return true; } };
K['jingle-stop'] = { name: 'Cortar sintonía', icon: 'stop', group: 'Sonido', render: () => key({ icon: 'stop', big: 'Cortar', small: 'Sintonía' }),
    key: (c) => { if (!ds(c)) return false; c.gs.send('director:sound', { action: 'jingle_stop' }); return true; } };
K['silence'] = { name: 'Silencio total', icon: 'mute', group: 'Sonido', render: () => key({ icon: 'mute', big: 'Silencio', tone: 'bad' }),
    key: (c) => { if (!ds(c)) return false; c.gs.send('director:sound', { action: 'silence' }); return true; } };
K['source'] = { name: 'Fuente: propia / Spotify', icon: 'spotify', group: 'Sonido',
    render: (c) => { const m = music(c), sp = (c.st && c.st.spotify) || {};
        if (!m || !sp.enabled) return key({ icon: 'music', big: 'Música propia', small: sp.enabled === false ? 'Sin Spotify' : '', tone: 'off' });
        return key({ icon: m.spotify ? 'spotify' : 'music', big: m.spotify ? 'Spotify' : 'Música propia', small: 'Fuente', tone: m.spotify ? 'on' : 'base' }); },
    key: (c) => { const m = music(c), sp = (c.st && c.st.spotify) || {}; if (!m || !sp.enabled) return false;
        c.gs.send('director:sound', { action: 'source', value: m.spotify ? 'own' : 'spotify' }); return true; } };
K['playlist'] = { name: 'Lista de Spotify', icon: 'list', group: 'Sonido', tip: 'Pone una lista (vacío = la lista del juego)', defaults: { uri: '' },
    render: (c) => { const m = music(c); return key({ icon: 'list', big: c.settings.uri ? 'Lista' : 'Lista del juego', small: 'Spotify', tone: m && m.spotify ? 'base' : 'off' }); },
    key: (c) => { const m = music(c); const uri = c.settings.uri || ((c.st && c.st.gameTheme) || {}).spotifyPlaylist;
        if (!m || !m.spotify || !uri) return false; c.gs.send('director:sound', { action: 'sp_playlist', uri }); return true; } };
K['volume'] = { name: 'Volumen + / −', icon: 'vol', group: 'Sonido', defaults: { target: 'music', step: 5 },
    render: (c) => { const v = volumeOf(c, c.settings.target), st = Number(c.settings.step) || 5;
        return key({ icon: st > 0 ? 'volUp' : 'volDown', big: v == null ? '—' : v + ' %', small: (c.settings.target === 'jingle' ? 'Sintonías ' : 'Música ') + (st > 0 ? '+' : '') + st, tone: v == null ? 'off' : 'base', bar: v == null ? null : v / 100 }); },
    key: (c) => { const v = volumeOf(c, c.settings.target); if (v == null) return false; return setVolume(c, c.settings.target, v + (Number(c.settings.step) || 5)); } };

K['status'] = { name: 'Estado de la conexión', icon: 'link', group: 'Juego', tip: 'Qué juego maneja este Stream Deck',
    render: (c) => { const s = c.gs.summary();
        const tone = s.ok ? 'on' : s.code === 'unpaired' ? 'warn' : 'bad';
        return key({ icon: s.ok ? 'link' : 'off', big: s.ok ? (s.gameName || 'Conectado') : s.title, small: s.ok ? 'Conectado' : s.hint, tone }); },
    key: () => false };

// ───────────────────────── Ruedas (Stream Deck +) ─────────────────────────
// Cada una pinta su parte de la franja táctil (layout $B1: título, icono, valor y barra; $A1: sin barra)
const D = {};

D['dial-volume'] = { name: 'Rueda de volumen', icon: 'vol', layout: '$B1', defaults: { target: 'music' },
    trigger: { rotate: 'Volumen', push: 'Música: pausa / sigue · Sintonías: lanzar', touch: 'Igual que pulsar' },
    render: (c) => {
        // Recién girada: se enseña lo pedido aunque el servidor aún no lo haya confirmado (si no, el número salta atrás)
        const v = c.mem.vol != null && Date.now() - c.mem.volAt < 1500 ? c.mem.vol : volumeOf(c, c.settings.target);
        const jin = c.settings.target === 'jingle', m = music(c);
        return { title: jin ? 'Sintonías' : (m && m.spotify ? 'Spotify' : 'Música'), value: v == null ? '—' : v + ' %', indicator: { value: v == null ? 0 : v }, icon: dialIcon(jin ? 'music' : (m && m.playing ? 'vol' : 'pause')) }; },
    rotate: (c, ticks) => {
        const base = c.mem.vol != null && Date.now() - c.mem.volAt < 1500 ? c.mem.vol : volumeOf(c, c.settings.target);
        if (base == null) return false;
        c.mem.vol = Math.max(0, Math.min(100, base + ticks * 2)); c.mem.volAt = Date.now();
        clearTimeout(c.mem.volT);
        // Como mucho una orden cada 150 ms (Spotify no aguanta más)
        c.mem.volT = setTimeout(() => setVolume(c, c.settings.target, c.mem.vol), 150);
        return { title: undefined, value: c.mem.vol + ' %', indicator: { value: c.mem.vol } };
    },
    push: (c) => c.settings.target === 'jingle' ? (ds(c) ? (c.gs.send('director:sound', { action: 'jingle' }), true) : false) : musicToggle(c) };

D['dial-track'] = { name: 'Rueda de canciones', icon: 'list', layout: '$A1',
    trigger: { rotate: 'Canción anterior / siguiente', push: 'Pausa / sigue', touch: 'Pausa / sigue' },
    render: (c) => { const m = music(c); return { title: m && m.spotify ? 'Spotify' : 'Canción', value: m ? (m.track || (m.empty ? 'Sin música' : '—')) : '—', icon: dialIcon(m && m.playing ? 'play' : 'pause') }; },
    rotate: (c, ticks) => { if (Date.now() - (c.mem.skipAt || 0) < 400) return true; c.mem.skipAt = Date.now(); return musicSkip(c, ticks); },
    push: (c) => musicToggle(c) };

D['dial-timer'] = { name: 'Rueda del crono', icon: 'clock', layout: '$B1',
    trigger: { rotate: '±5 s', push: 'Empezar / parar', touch: 'Empezar / parar' },
    render: (c) => { const d = ds(c), t = d && d.timer, type = d && d.currentRound && d.currentRound.type;
        if (!t || !inQuestion(c) || NO_TIMER.has(type)) return { title: 'Crono', value: 'Sin tiempo', indicator: { value: 0 }, icon: dialIcon('clock', '#7c7f93') };
        return { title: t.running ? 'Crono · en marcha' : 'Crono · parado', value: mmss(t.remaining), indicator: { value: t.total ? Math.round(t.remaining / t.total * 100) : 0 }, icon: dialIcon('clock', t.running ? '#4ade80' : '#ffffff') }; },
    rotate: (c, ticks) => {
        if (!inQuestion(c)) return false;
        c.mem.add = (c.mem.add || 0) + ticks * 5;
        clearTimeout(c.mem.addT);
        c.mem.addT = setTimeout(() => { const s = c.mem.add; c.mem.add = 0; if (s) c.gs.send('director:extend_timer', { seconds: s }); }, 250);
        return true;
    },
    push: (c) => K['timer'].key(c) };

// Rueda que recorre una lista (rondas o tipos): girar elige, pulsar lanza
function listDial(name, icon, items, label, launch) {
    return { name, icon, layout: '$A1',
        trigger: { rotate: 'Elegir', push: 'Lanzar', touch: 'Lanzar' },
        render: (c) => { const list = items(c); if (!list.length) return { title: name, value: '—', icon: dialIcon(icon, '#7c7f93') };
            const i = Math.max(0, Math.min(list.length - 1, c.mem.cursor != null ? c.mem.cursor : defaultIdx(c, list)));
            return { title: name + ' ' + (i + 1) + '/' + list.length, value: label(list[i]), icon: dialIcon(icon) }; },
        rotate: (c, ticks) => { const list = items(c); if (!list.length) return false;
            const cur = c.mem.cursor != null ? c.mem.cursor : defaultIdx(c, list);
            c.mem.cursor = ((cur + ticks) % list.length + list.length) % list.length;
            clearTimeout(c.mem.cursorT); c.mem.cursorT = setTimeout(() => { c.mem.cursor = null; c.refresh(); }, 15000); // vuelve sola a la sugerida
            return true; },
        push: (c) => { const list = items(c); if (!list.length) return false;
            const i = c.mem.cursor != null ? c.mem.cursor : defaultIdx(c, list);
            launch(c, list[i]); c.mem.cursor = null; return true; } };
    function defaultIdx(c, list) {
        if (name === 'Ronda') { const r = ds(c) && nextRound(ds(c), c.rounds); return Math.max(0, list.indexOf(r)); }
        const sel = ds(c) && (ds(c).selectedCategory || (ds(c).currentRound && ds(c).currentRound.type));
        return Math.max(0, list.indexOf(sel));
    }
}
D['dial-round'] = listDial('Ronda', 'skipF', (c) => c.rounds || [], (r) => r.name, (c, r) => c.gs.send('director:launch_round', { roundId: r.id }));
D['dial-round'].name = 'Rueda de rondas';
D['dial-type'] = listDial('Tipo', 'grid', (c) => typesOf(c.rounds), (t) => TYPE_LABELS[t] || t, (c, t) => c.gs.send('director:select_category', { category: t }));
D['dial-type'].name = 'Rueda de tipos de prueba';

D['dial-question'] = { name: 'Rueda de preguntas', icon: 'next', layout: '$A1',
    trigger: { rotate: 'Pregunta anterior / siguiente', push: 'Siguiente paso', touch: 'Siguiente paso' },
    render: (c) => { const d = ds(c), s = nextStep(c.st, c.rounds);
        return { title: inQuestion(c) ? 'Pregunta ' + (d.currentQuestionIdx + 1) + '/' + d.questions.length : 'Juego', value: s.sub ? s.label + ' · ✓ o ✗' : s.label, icon: dialIcon('next', s.none ? '#facc15' : '#ffffff') }; },
    rotate: (c, ticks) => { if (Date.now() - (c.mem.qAt || 0) < 500) return true; c.mem.qAt = Date.now();
        return ticks > 0 ? K['q-next'].key(c) : K['q-prev'].key(c); },
    push: (c) => K['next-step'].key(c) };

const ALL = {};
for (const [id, a] of Object.entries(K)) ALL[PREFIX + id] = Object.assign({ id, kind: 'key' }, a);
for (const [id, a] of Object.entries(D)) ALL[PREFIX + id] = Object.assign({ id, kind: 'dial' }, a);

module.exports = { ACTIONS: ALL, PREFIX, TYPE_LABELS, typesOf };
