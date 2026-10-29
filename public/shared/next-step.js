// «Siguiente paso»: lo que toca ahora en la prueba, mirando el mismo estado que el coordinador
// (game:director_sync). Devuelve { label, ev, data } o, si eso lo tiene que decidir una persona
// en el coordinador (equipo que pulsó, bono, karaoke…), { label, none: true }.
// Compartido por el complemento del Stream Deck (streamdeck/src/next-step.js lo reexporta) y la
// vista de presentador del coordinador: los dos siguen las mismas reglas.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GSNextStep = api;
})(typeof self !== 'undefined' ? self : this, function () {

const BUZZ = new Set(['pulsador', 'imagen', 'imagen_fija', 'cancion', 'aclara', 'ruleta']);
const OPEN_FIRST = {
    multirespuesta: 'Abrir opciones', boom: 'Abrir opciones', identidad: 'Abrir opciones',
    cifras: 'Empezar las cuentas', letras: 'Empezar', precio: 'Iniciar tiempo',
};

const step = (label, ev, data) => ({ label, ev, data: data || {} });
const none = (label, sub) => ({ label, sub, none: true });

// Revelado por pasos pendiente (Boom, Identidad, Respuesta abierta, Cifras, Letras): «3/5» o null
function revealPending(ds, type, c) {
    let n = null, total = null;
    if (type === 'letras' && ds.letras && ds.letras.step === 'revealed' && ds.phase === 'answer_revealed') { n = ds.letras.revealStep || 0; total = ds.letras.total; }
    else if (type === 'cifras' && ds.cifras && ds.phase === 'answer_revealed') { n = ds.cifras.revealStep || 0; total = ds.cifras.total; }
    else if (type === 'abierta' && ds.abierta && ds.abierta.step === 'revealed') { n = ds.abierta.revealStep || 0; total = (c.subs || []).length; }
    else if (type === 'boom' && ds.phase === 'answer_revealed' && typeof ds.boomStep === 'number') { n = ds.boomStep; total = (c.items || []).length; }
    else if (type === 'identidad' && ds.identidad && ds.phase === 'answer_revealed') { n = ds.identidad.revealIndex || 0; total = (c.pairs || []).length; }
    if (n === null || !(total > 0) || n >= total) return null;
    return (n + 1) + '/' + total;
}

// La siguiente ronda de la escaleta que no se ha jugado (después de la actual)
function nextRound(ds, rounds) {
    rounds = rounds || [];
    const done = new Set(ds.completedRounds || []);
    const cur = rounds.findIndex(r => r.id === ds.currentRoundId);
    for (let i = cur + 1; i < rounds.length; i++) if (!done.has(rounds[i].id)) return rounds[i];
    return rounds.find(r => !done.has(r.id) && r.id !== ds.currentRoundId) || null;
}

function nextStep(st, rounds) {
    const ds = st && st.director;
    if (!ds) return none('Sin juego');
    const type = ds.currentRound && ds.currentRound.type;
    const q = ds.questions && ds.questions[ds.currentQuestionIdx];
    const c = (q && q.content) || {};
    const cola = st.colaPulsador || [];
    switch (ds.phase) {
        case 'round_intro':
            return step('Empezar ronda', 'director:start_round');
        case 'question': {
            if (type === 'karaoke') return none('Karaoke: en el coordinador');
            if (ds.preCountdown) return none('Empieza…');
            if (type === 'abierta' && ds.abierta) {
                const s = ds.abierta.step;
                if (s === 'intro') return step('Mostrar enunciado', 'director:abierta_show');
                if (s === 'shown') return step('Abrir respuestas', 'director:abierta_open');
                if (s === 'open') return step('Cerrar respuestas', 'director:abierta_close');
                if (s === 'correcting') return step('Revelar', 'director:abierta_reveal');
            }
            if (OPEN_FIRST[type] && !ds.optionsRevealed && !(type === 'letras' && ds.letras)) return step(OPEN_FIRST[type], 'director:reveal_options');
            if (type === 'pictionary' && ds.pictionary && ds.pictionary.step === 'setup') {
                if (ds.pictionary.mode !== 'ipad' && !ds.pictionary.drawer) return none('Elige quién dibuja');
                return step('Empezar a dibujar', 'director:pic_start');
            }
            // Ruleta: primero se enseña el panel en la sala (también abre el pulsador), como en el coordinador
            if (type === 'ruleta' && !ds.roulettePanelVisible && !ds.buzzerWinner && !cola.length) return step('Mostrar panel', 'director:show_roulette_panel');
            if (BUZZ.has(type) || type === 'pictionary') {
                if (cola.length) return none(cola[0].nombre || 'Un equipo', 'Pulsó · ✓ o ✗');
                if (!st.pulsadorActivo && !ds.buzzerWinner) return step('Abrir pulsador', 'director:open_buzzer');
                return step('Mostrar respuesta', 'director:reveal_answer');
            }
            if (type === 'letras') return step(ds.letras ? 'Revelar' : 'Cerrar', 'director:reveal_answer');
            const pend = revealPending(ds, type, c);
            if (pend) return step('Ir revelando ' + pend, 'director:reveal_next_pair');
            return step('Mostrar respuesta', 'director:reveal_answer');
        }
        case 'answer_revealed': {
            const pend = revealPending(ds, type, c);
            if (pend) return step('Ir revelando ' + pend, 'director:reveal_next_pair');
            if (q && q.config && q.config.premio) return none('Bono: elige en el coordinador');
            if (ds.currentQuestionIdx >= (ds.questions || []).length - 1) return step('Terminar ronda', 'director:finish_round');
            return step('Siguiente pregunta', 'director:next_question');
        }
        default: {
            // Pregunta dejada a medias por Espera o Home: primero, volver a ella (no saltar a otra ronda)
            if ((ds.phase === 'waiting' || ds.phase === 'lobby') && ds.resumePhase) return step('Volver a la prueba', 'director:resume_question');
            // Sala de espera del principio: se entra al Home (no se lanza una ronda con equipos aún entrando)
            if (ds.phase === 'lobby' && !ds.menuLevel) return (st.equipos || []).length ? step('Iniciar juego', 'director:show_home') : none('Esperando equipos…');
            const r = nextRound(ds, rounds);
            if (r) return step('Ronda: ' + r.name, 'director:launch_round', { roundId: r.id });
            return none('No quedan rondas');
        }
    }
}

return { nextStep, nextRound, revealPending, BUZZ };
});
