// Vista de presentador: el mismo coordinador, pintado en grande para llevar el iPad en la mano.
// No tiene estado propio: lee S (lo que manda game:director_sync) y usa las mismas órdenes y
// funciones del coordinador (emit, handleNextQuestion, markFirst…). El botón grande sigue las
// reglas de shared/next-step.js, las mismas que la tecla «Siguiente paso» del Stream Deck.
// La ruleta, elegir quién dibuja en Pictionary y corregir Respuesta abierta y Letras tienen aquí
// su versión en grande; el resto (karaoke, reproductor de canción…) se abre con «Panel de la
// prueba»: el panel de siempre a pantalla completa. Se activa con «🎤 Presentador» o con ?presentador=1 y cada
// dispositivo recuerda su modo (el PC del control sigue con la vista completa).
var PV = (function () {
    var KEY = 'gs_presenter';
    var BUZZ = GSNextStep.BUZZ;
    var LETTERS = 'ABCDEFGHIJKLMNOP';
    var on = false, sheet = null, lockUntil = 0, lockAt = 0, lockText = '', wake = null, dragging = false;
    var acts = [];          // acciones de los botones de este pintado (data-i → función)
    var painted = {};       // último HTML de cada zona: solo se repinta si cambia (no comerse toques)
    var zoneActs = {};      // acciones con las que se pintó cada zona (su data-i apunta aquí)
    var lastPrimary = '';

    // ── Estructura ──
    var root = document.createElement('div');
    root.id = 'pv';
    root.innerHTML = '<div class="pv-top">'
        + '<button class="btn-ghost" data-a="sheet" data-s="esc">&#128203; Escaleta</button>'
        + '<div class="pv-title"><b id="pvTitle"></b><small id="pvSub"></small></div>'
        + '<button class="pv-timer off" id="pvTimer" data-a="timer">--:--</button>'
        + '<button class="btn-ghost" data-a="sheet" data-s="more">&#8943; M&aacute;s</button>'
        + '</div>'
        + '<div class="pv-main"><div class="pv-body" id="pvBody"></div><div class="pv-actions" id="pvActions"></div></div>'
        + '<div class="pv-sheet" id="pvSheet"><div class="pv-top"><div class="pv-title"><b id="pvSheetTitle"></b><small id="pvSheetSub"></small></div>'
        + '<button class="btn-ghost" data-a="close">&#10005; Cerrar</button></div><div class="pv-sheet-body" id="pvSheetBody"></div></div>';
    document.body.appendChild(root);
    var back = document.createElement('div');
    back.id = 'pvBack';
    back.innerHTML = '<button class="btn-accent" data-a="panel-off">&#8592; Presentador</button><span>Panel de la prueba (el del coordinador)</span>';
    document.body.appendChild(back);
    var $ = function (id) { return document.getElementById(id); };

    // ── Ayudas ──
    function D() { return S.director; }
    function type() { var d = D(); return d && d.currentRound ? d.currentRound.type : ''; }
    function curQ() { var d = D(); return d && d.questions ? d.questions[d.currentQuestionIdx] : null; }
    function label(t) { return t === 'karaoke' ? 'Karaoke' : (TYPE_LABELS[t] || t || ''); }
    function teamName(id) { var t = S.equipos.find(function (e) { return e.id === id; }); return t ? t.nombre : '?'; }
    function isLast() { var d = D(); return d.currentQuestionIdx >= (d.questions || []).length - 1; }
    function inQuestion() { var d = D(); return d && (d.phase === 'question' || d.phase === 'answer_revealed') && d.currentQuestionIdx >= 0; }
    function act(fn) { acts.push(fn); return acts.length - 1; }
    function btn(text, fn, cls, extra) { return '<button class="' + (cls || 'btn-ghost') + '" data-a="act" data-i="' + act(fn) + '"' + (extra || '') + '>' + text + '</button>'; }
    // Los data-i cambian en cada pintado: se compara sin ellos. Devuelve si ha repintado.
    function paint(id, html) {
        var key = html.replace(/ data-i="\d+"/g, '');
        if (painted[id] === key) return false;
        painted[id] = key;
        $(id).innerHTML = html;
        zoneActs[id] = acts.slice();
        return true;
    }
    function ranking() {
        var sc = (D() && D().scores) || {};
        return S.equipos.slice().sort(function (a, b) { return (sc[b.id] || 0) - (sc[a.id] || 0); })
            .map(function (e) { return { team: e, pts: sc[e.id] || 0 }; });
    }
    function rowsHtml(list, max) {
        var html = '<div class="pv-rows">';
        list.slice(0, max || list.length).forEach(function (r, i) {
            html += '<div class="pv-row"><span class="pos">' + (i + 1) + '</span><span class="nm">' + esc(r.team.nombre) + '</span><span class="pt">' + r.pts + '</span></div>';
        });
        if (max && list.length > max) html += '<div class="pv-note">y ' + (list.length - max) + ' equipos más</div>';
        return html + '</div>';
    }
    function panelOn() { document.body.classList.add('pv-panel'); closeSheet(); }
    function panelOff() { document.body.classList.remove('pv-panel'); render(); }
    function openMusic() {
        var panel = $('sndPanel');
        if (!panel.classList.contains('active')) toggleSoundPanel($('btnSound'));
        panel.classList.add('expanded');
        renderSound();
    }

    // ── Chuleta: lo que hay que leer y la respuesta (los jugadores no ven este iPad) ──
    function statementOf(t, c) {
        if (t === 'pictionary') return D().pictionary && D().pictionary.drawer ? 'Dibujan: ' + teamName(D().pictionary.drawer) : 'Pictionary: falta elegir quién dibuja';
        if (t === 'aclara') return c.statement || '¿Qué es esta imagen?';
        if (t === 'letras') return 'Letras: ' + (c.letters || []).join(' ');
        if (t === 'cifras') return 'Llegar a ' + c.target + ' con ' + (c.numbers || []).join(' · ') + (c.useAll ? ' (usando todas)' : '');
        return c.statement || c.question || '';
    }
    function answerOf(t, c) {
        if (t === 'pictionary') return c.word ? esc(c.word) + (c.category ? ' <small style="display:inline">(' + esc(c.category) + ')</small>' : '') : '';
        if (t === 'ruleta') return esc(c.phrase || '');
        if (t === 'letras') return c.best && c.best.words && c.best.words.length ? 'La más larga (' + c.best.len + '): ' + esc(c.best.words.map(Letras.upper).join(' · ')) : 'La más larga: se calcula al revelar';
        if (t === 'cifras') return Array.isArray(c.solution) && c.solution.length ? esc(c.solution.map(Cifras.fmtStep).join('  ·  ')) : 'Solución: se calcula al cerrar';
        if (t === 'abierta') return (c.subs || []).map(function (s, i) { return (i + 1) + '. ' + esc(s.text || '') + ' → ' + esc(s.answer || ''); }).join('<br>');
        if (c.options && c.correct !== undefined) return '';            // se marca en las opciones
        if (c.answer !== undefined && c.answer !== '') return esc(String(c.answer));
        if (c.correct_value !== undefined) return esc(String(c.correct_value));
        if (c.correct_order && c.items) return c.correct_order.map(function (i) { return esc(c.items[i]); }).join(' → ');
        if (c.pairs) return c.pairs.map(function (p) { return esc((p.left && p.left.text) || '📷') + ' → ' + esc((p.right && p.right.text) || '📷'); }).join('<br>');
        return '';
    }
    function chuletaHtml() {
        var t = type(), q = curQ();
        if (!q) return '';
        var c = q.content || {};
        var html = '<div class="pv-card">';
        var st = statementOf(t, c);
        if (st) html += '<div class="pv-q">' + esc(st) + '</div>';
        var media = c.video ? null : (t === 'imagen' || t === 'imagen_fija' || t === 'aclara' ? c.image : (q.media_url || c.image));
        if (media) html += '<img class="pv-media" src="' + esc(media) + '" alt="">';
        if (c.video) html += '<div class="pv-hints">&#127916; Vídeo en pantalla</div>';
        if (c.options && c.options.length) {
            var corr = Array.isArray(c.correct) ? c.correct : [c.correct];
            html += '<div class="pv-opts">' + c.options.map(function (o, i) {
                return '<div class="pv-opt' + (corr.indexOf(i) >= 0 ? ' ok' : '') + '">' + LETTERS[i] + ' · ' + esc(o) + (corr.indexOf(i) >= 0 ? ' ✓' : '') + '</div>';
            }).join('') + '</div>';
        }
        var ans = answerOf(t, c);
        if (ans) html += '<div class="pv-ans"><small>' + (t === 'pictionary' ? 'Palabra' : t === 'cifras' ? 'Solución' : 'Respuesta') + '</small>' + ans + '</div>';
        if (c.hints && c.hints.length && t !== 'aclara') html += '<div class="pv-hints">Pistas: ' + c.hints.map(esc).join(' · ') + '</div>';
        if (c.hint) html += '<div class="pv-hints">Pista: ' + esc(c.hint) + '</div>';
        return html + '</div>';
    }

    // ── Lo que pasa ahora en la prueba ──
    function statusHtml() {
        var d = D(), t = type();
        if (d.phase === 'question' && t === 'karaoke') return '<div class="pv-card pv-note">El karaoke se lleva desde el panel de la prueba (asignar colores, avanzar y puntuar).</div>';
        if (d.phase === 'question' && (BUZZ.has(t) || t === 'pictionary')) {
            if (S.colaPulsador.length) {
                var first = S.colaPulsador[0];
                var rest = S.colaPulsador.slice(1).map(function (e, i) { return (i + 2) + '. ' + esc(e.nombre); }).join(' · ');
                return '<div class="pv-card pv-buzz"><small>Ha pulsado</small><div class="who">' + esc(first.nombre) + '</div>'
                    + (rest ? '<div class="pv-queue">En cola: ' + rest + '</div>' : '') + '</div>';
            }
            var failed = (d.buzzerFailed || []).map(teamName);
            var txt = d.buzzerWinner ? '&#10004; Acertó <b>' + esc(teamName(d.buzzerWinner)) + '</b>'
                : S.pulsadorActivo ? '&#128276; Pulsador abierto · esperando' : 'Pulsador cerrado';
            return '<div class="pv-card pv-note" style="font-size:17px">' + txt
                + (failed.length ? '<div class="pv-hints">Han fallado: ' + failed.map(esc).join(', ') + '</div>' : '') + '</div>';
        }
        if (correcting()) return '<div class="pv-card pv-warn pv-note">Corrigiendo: toca cada respuesta para cambiarla entre ✓ y ✗; luego, «Revelar».</div>';
        if (d.phase === 'question' && (d.optionsRevealed || t === 'abierta' && d.abierta && d.abierta.step === 'open')) {
            return '<div class="pv-card pv-big"><div class="n">' + (d.answeredCount || 0) + ' / ' + S.equipos.length + '</div><div class="l">equipos han respondido</div></div>';
        }
        if (d.phase === 'answer_revealed') {
            var lqs = d.lastQuestionScores || {};
            var list = S.equipos.map(function (e) { return { team: e, r: lqs[e.id] || {} }; })
                .filter(function (x) { return x.r.points > 0 || x.r.correct; })
                .sort(function (a, b) { return (b.r.points || 0) - (a.r.points || 0); });
            var html = '<div class="pv-card"><h3>' + list.length + ' de ' + S.equipos.length + ' equipos puntúan</h3><div class="pv-rows">';
            list.slice(0, 8).forEach(function (x) {
                html += '<div class="pv-row"><span class="ok">✓</span><span class="nm">' + esc(x.team.nombre) + '</span><span class="pt">+' + (x.r.points || 0) + '</span></div>';
            });
            if (list.length > 8) html += '<div class="pv-note">y ' + (list.length - 8) + ' más</div>';
            return html + '</div></div>';
        }
        return '';
    }

    // ── Pruebas con mando propio, en grande (antes iban al panel del coordinador) ──
    // Ruleta: el panel con la frase entera (lo destapado resaltado) y un teclado con sus letras
    function ruletaHtml(c) {
        var d = D(), solved = !!d.rouletteSolved, rev = {};
        (d.rouletteRevealed || []).forEach(function (l) { rev[l] = true; });
        var PUNCT = ',.!?¡¿:;—–-\'"()';
        var board = (c.phrase || '').toUpperCase().split(' ').filter(Boolean).map(function (w) {
            return '<span class="pv-rw">' + Array.prototype.map.call(w, function (ch) {
                var p = PUNCT.indexOf(ch) >= 0;
                return '<span class="pv-rc' + (p ? ' p' : rev[ch] || solved ? ' on' : '') + '">' + esc(ch) + '</span>';
            }).join('') + '</span>';
        }).join('');
        var kb = RoulettePanel.uniqueLetters(c.phrase || '').sort().map(function (ch) {
            var done = rev[ch] || solved;
            return btn(ch, function () { emit('director:reveal_letter', { letter: ch }); }, 'pv-kb' + ('AEIOUÁÉÍÓÚÜ'.indexOf(ch) >= 0 ? ' v' : '') + (done ? ' done' : ''), done ? ' disabled' : '');
        }).join('');
        return '<div class="pv-card"><h3>Panel de la sala' + (solved ? ' · resuelto' : '') + '</h3><div class="pv-rboard">' + board + '</div></div>'
            + '<div class="pv-card"><h3>Destapar letra</h3><div class="pv-kbd">' + kb + '</div>'
            + '<div class="pv-sec" style="margin-top:10px">' + btn('&#9989; Resolver', function () { emit('director:solve_roulette'); }, 'btn-success', solved ? ' disabled' : '')
            + btn('&#128260; Reset letras', resetRuleta) + '</div></div>';
    }
    // Pictionary antes de empezar: quién dibuja (o la pizarra fija y su QR)
    function picSetupHtml() {
        var d = D(), p = d.pictionary || {};
        if (p.mode === 'ipad') {
            return '<div class="pv-card pv-note">' + (d.padConnected ? '&#128241; Pizarra conectada' : '&#9888;&#65039; La pizarra no está conectada')
                + '<div class="pv-sec" style="margin-top:10px">' + btn('&#128241; QR de la pizarra', openPicPad) + '</div></div>';
        }
        var done = d.picDone || [];
        return '<div class="pv-card"><h3>¿Quién dibuja? (toca para elegir)</h3><div class="pv-grid pv-pick">' + S.equipos.map(function (e) {
            return btn(esc(e.nombre) + (done.indexOf(e.id) >= 0 ? '<small>&#10003; ya dibujó</small>' : !e.ocupado ? '<small>sin conexión</small>' : ''),
                function () { emit('director:pic_set_drawer', { teamId: e.id }); }, 'pv-tile' + (e.id === p.drawer ? ' on' : '') + (!e.ocupado ? ' done' : ''));
        }).join('') + '</div></div>';
    }
    // Corregir (o rectificar ya revelada) Respuesta abierta y Letras: los mismos bloques del
    // coordinador, con sus mismos botones (data-ab / data-ltmark, escuchados en el coordinador)
    function correctionHtml(rectify) {
        var d = D(), t = type(), q = curQ(), c = (q && q.content) || {};
        if (t === 'abierta') return '<div class="pv-card pv-ab">' + abCorrectionHtml(d, abSubsOf(q), rectify) + '</div>';
        if (t === 'letras' && d.letras) return '<div class="pv-card pv-lt"><div class="pv-note">Lo que marques vale para todos los equipos que pusieron esa palabra.</div>' + letrasCorrectionHtml(d, c) + '</div>';
        return '';
    }
    function correcting() {
        var d = D(), t = type();
        return d.phase === 'question' && ((t === 'abierta' && d.abierta && d.abierta.step === 'correcting') || (t === 'letras' && d.letras && d.letras.step === 'correcting'));
    }
    function specialHtml() {
        var d = D(), t = type(), q = curQ(), c = (q && q.content) || {};
        if (d.phase !== 'question') return '';
        if (t === 'ruleta' && d.roulettePanelVisible) return ruletaHtml(c);
        if (t === 'pictionary' && d.pictionary && d.pictionary.step === 'setup') return picSetupHtml();
        if (correcting()) return correctionHtml(false);
        return '';
    }

    // Lo que está saliendo en la pantalla de sala por encima de la prueba
    function overlaysHtml() {
        var d = D(), html = '';
        if (d.scoreboardVisible) html += '<div class="pv-card"><h3>&#127942; Ranking en pantalla</h3>' + rowsHtml(ranking(), 12)
            + '<div class="pv-sec" style="margin-top:10px">' + btn('Quitar ranking', toggleScoreboard) + '</div></div>';
        if (d.qrVisible) html += '<div class="pv-card pv-note">&#128241; QR en pantalla ' + btn('Quitar', function () { emit('director:toggle_qr'); }, 'btn-ghost btn-sm') + '</div>';
        if (d.premioAnuncioVisible) html += '<div class="pv-card pv-note">&#127873; Anuncio de bono en pantalla ' + btn('Quitar', function () { emit('director:toggle_premio_anuncio'); }, 'btn-ghost btn-sm') + '</div>';
        if (d.premioGanadorVisible) html += '<div class="pv-card pv-note">&#127941; Ganador del bono en pantalla ' + btn('Quitar', function () { emit('director:toggle_premio_ganador'); }, 'btn-ghost btn-sm') + '</div>';
        return html;
    }

    // ── Botón grande: lo que toca ahora ──
    function primary() {
        var d = D(), t = type();
        if (d.phase === 'lobby' && !d.menuLevel) {
            return S.equipos.length ? { text: '&#9654; Iniciar juego', fn: function () { emit('director:show_home'); }, cls: 'btn-success' } : { text: 'Esperando equipos…', idle: true };
        }
        if (d.phase === 'question' && S.colaPulsador.length && (BUZZ.has(t) || t === 'pictionary')) return null; // ✓ / ✗ ocupan su sitio
        var pic = d.pictionary;
        if (t === 'pictionary' && d.phase === 'question' && pic && pic.step === 'setup' && pic.mode !== 'ipad' && !pic.drawer) return { text: 'Elige arriba quién dibuja', idle: true };
        var st = GSNextStep.nextStep(S, S.rounds);
        if (st.none) {
            var q = curQ();
            if (d.phase === 'answer_revealed' && q && q.config && q.config.premio) return { text: '&#127873; Bono: elegir ganador', fn: isLast() ? handleFinishRound : handleNextQuestion, cls: 'btn-orange' };
            if (t === 'karaoke' && d.phase === 'question') return { text: '&#127908; Abrir panel del karaoke', fn: panelOn, cls: 'btn-accent' };
            return { text: esc(st.label), idle: true };
        }
        var ev = st.ev, cls = 'btn-accent', text = esc(st.label), fn;
        if (ev === 'director:next_question') { fn = handleNextQuestion; cls = 'btn-success'; text += ' &#9654;'; }
        else if (ev === 'director:finish_round') { fn = handleFinishRound; cls = 'btn-success'; text = '&#10004; ' + text; }
        else if (ev === 'director:launch_round') { fn = function () { launchRound(st.data.roundId); }; cls = 'btn-success'; text = '&#9654; Siguiente: ' + esc(st.label.replace(/^Ronda: /, '')); }
        else if (ev === 'director:start_round' || ev === 'director:resume_question') { cls = 'btn-success'; text = '&#9654; ' + text; }
        else if (ev === 'director:reveal_next_pair') cls = 'btn-orange';
        else if (ev === 'director:abierta_close') fn = function () {
            // Como en el coordinador: avisar si alguien sigue escribiendo (lo que tenga contará igual)
            var pending = S.equipos.filter(function (e) { var x = (d.answers || {})[e.id]; return !e.bloqueado && !(x && x.submitted); }).length;
            if (pending && !confirm((pending === 1 ? 'Queda 1 equipo' : 'Quedan ' + pending + ' equipos') + ' sin enviar. Lo que tengan escrito contará igual. ¿Cerrar las respuestas?')) return;
            emit(ev);
        };
        if (!fn) fn = function () { emit(ev, st.data); };
        return { text: text, fn: fn, cls: cls };
    }

    // ── Botones pequeños según el momento ──
    function secondary() {
        var d = D(), t = type(), q = curQ(), c = (q && q.content) || {}, out = [];
        var add = function (text, fn, cls) { out.push(btn(text, fn, cls)); };
        if (d.phase === 'lobby' || d.phase === 'round_end') {
            add('&#127942; Ranking', toggleScoreboard, d.scoreboardVisible ? 'btn-ghost active' : null);
            if (d.phase === 'round_end' || d.menuLevel === 'category') add('&#127968; Home', function () { emit('director:show_home'); });
            add('&#9208; Espera', function () { emit('director:show_waiting'); });
            if (d.phase === 'lobby') add('&#128241; QR', function () { emit('director:toggle_qr'); }, d.qrVisible ? 'btn-ghost active' : null);
        } else if (d.phase === 'round_intro' || d.phase === 'waiting') {
            add('&#127968; Home', function () { emit('director:show_home'); });
        } else if (d.phase === 'question') {
            if (!$('pvTimer').classList.contains('off')) add('+10 s', function () { emit('director:extend_timer', { seconds: 10 }); });
            if ((BUZZ.has(t) || t === 'pictionary') && S.pulsadorActivo && !S.colaPulsador.length) add('Cerrar pulsador', function () { emit('director:close_buzzer'); });
            if (t === 'aclara') {
                if (d.aclara && d.aclara.running) add('&#9208; Pausa', function () { emit('director:aclara_pause'); });
                else add('&#9654; Aclarar', function () { emit('director:aclara_play'); });
            }
            if (t === 'imagen') add('Destapar todo', function () { emit('director:image_reveal_all'); });
            if (t === 'imagen_fija' && c.video) {
                add('&#9654; Vídeo', function () { emit('director:video_command', { action: 'play' }); });
                add('&#10074;&#10074;', function () { emit('director:video_command', { action: 'pause' }); });
                add('&#8634;', function () { emit('director:video_command', { action: 'restart' }); });
            }
        } else if (d.phase === 'answer_revealed') {
            add('&#128101; Resultados en pantalla', function () { emit('director:toggle_team_results'); }, d.showTeamResults ? 'btn-ghost active' : null);
            if (t === 'abierta' || (t === 'letras' && d.letras)) add('&#9997;&#65039; Rectificar', function () { openSheet('fix'); });
        }
        if (inQuestion()) {
            // El panel de siempre para lo que aquí no está; resaltado cuando hace falta
            var need = t === 'karaoke' || t === 'cancion';
            add('&#128736; ' + (t === 'cancion' ? 'Reproductor' : t === 'karaoke' ? 'Panel del karaoke' : 'Panel de la prueba'), panelOn, need ? 'btn-orange' : null);
        }
        return out.join('');
    }

    // ── Cuerpo según la fase ──
    function bodyHtml() {
        var d = D(), t = type(), html = overlaysHtml();
        if (d.phase === 'lobby' && d.menuLevel === 'home') {
            var gt = (S.game && S.game.theme) || {}, cats = getCategories(), done = d.completedRounds || [];
            html += '<div class="pv-grid">' + Object.keys(cats).map(function (k) {
                var logo = gt.types && gt.types[k] && gt.types[k].logo;
                var allDone = cats[k].every(function (r) { return done.indexOf(r.id) >= 0; });
                return btn(logo ? '<img src="' + esc(logo) + '" alt="">' + '<span>' + esc(label(k)) + '</span>' : esc(label(k)),
                    function () { emit('director:select_category', { category: k }); }, 'pv-tile' + (allDone ? ' done' : ''));
            }).join('') + '</div>';
        } else if (d.phase === 'lobby' && d.menuLevel === 'category') {
            var cat = d.selectedCategory, doneR = d.completedRounds || [];
            html += '<div class="pv-sec">' + btn('&#8592; Volver al Home', function () { emit('director:show_home'); }) + '</div>';
            html += '<div class="pv-grid">' + S.rounds.filter(function (r) { return r.type === cat; }).map(function (r) {
                return btn(esc(r.name) + '<small style="color:var(--text2);font-weight:500">' + (r.questions || []).length + ' preg.</small>',
                    function () { launchRound(r.id); }, 'pv-tile' + (doneR.indexOf(r.id) >= 0 ? ' done' : ''));
            }).join('') + '</div>';
        } else if (d.phase === 'lobby') {
            var conn = S.equipos.filter(function (e) { return e.ocupado; }).length;
            html += '<div class="pv-card pv-big"><div class="n">' + conn + ' / ' + S.equipos.length + '</div><div class="l">iPads de equipo conectados</div></div>';
            if (S.equipos.length) html += '<div class="pv-card"><div class="pv-rows">' + S.equipos.map(function (e) {
                return '<div class="pv-row"><span class="dot' + (e.ocupado ? ' on' : '') + '"></span><span class="nm">' + esc(e.nombre) + '</span></div>';
            }).join('') + '</div></div>';
            else html += '<div class="pv-card pv-note">Todavía no hay equipos. Se crean desde el control completo.</div>';
        } else if (d.phase === 'round_intro') {
            var r = d.currentRound || {};
            html += '<div class="pv-card pv-big"><div class="l">' + esc(label(r.type)) + '</div><div class="n" style="font-size:32px">' + esc(r.name || '') + '</div>'
                + '<div class="l">' + (d.questions || []).length + ' preguntas · los jugadores ven la intro</div></div>';
        } else if (d.phase === 'question' || d.phase === 'answer_revealed') {
            var idx = d.currentQuestionIdx, total = (d.questions || []).length;
            html += '<div class="pv-sec">' + btn('&#9664; Anterior', function () { emit('director:prev_question'); }, 'btn-ghost', idx <= 0 ? ' disabled' : '')
                + '<button class="btn-ghost" disabled style="opacity:1;color:var(--text)">Pregunta ' + (idx + 1) + ' de ' + total + '</button>'
                // Revelada, el botón grande ya es «Siguiente»; aquí solo para saltar una sin jugarla
                + (d.phase === 'question' ? btn(idx >= total - 1 ? 'Terminar &#10004;' : 'Saltar &#9654;', isLast() ? handleFinishRound : handleNextQuestion) : '') + '</div>';
            if (d.phase === 'answer_revealed') html += statusHtml() + chuletaHtml();
            else if (correcting()) html += statusHtml() + specialHtml() + chuletaHtml();
            else html += chuletaHtml() + statusHtml() + specialHtml();
        } else if (d.phase === 'round_end') {
            html += '<div class="pv-card pv-big"><div class="n" style="font-size:30px">&#127881; Fin de la ronda</div><div class="l">' + esc((d.currentRound && d.currentRound.name) || '') + '</div></div>';
            html += '<div class="pv-card"><h3>Clasificación</h3>' + rowsHtml(ranking(), 10) + '</div>';
        } else if (d.phase === 'waiting') {
            html += '<div class="pv-card pv-big"><div class="n" style="font-size:30px">&#9208; Pantalla de espera</div><div class="l">Los jugadores ven la espera</div></div>';
        }
        return html;
    }

    function titles() {
        var d = D(), t = type();
        if (d.phase === 'lobby' || d.phase === 'waiting') return [S.game ? S.game.name : 'Juego', d.menuLevel === 'category' ? label(d.selectedCategory) : d.menuLevel === 'home' ? 'Home' : d.phase === 'waiting' ? 'Espera' : 'Antes de empezar'];
        var r = d.currentRound || {};
        var sub = label(t);
        if (inQuestion()) sub += ' · Pregunta ' + (d.currentQuestionIdx + 1) + '/' + (d.questions || []).length + (d.phase === 'answer_revealed' ? ' · revelada' : '');
        return [r.name || label(t), sub];
    }

    // ── Pintar ──
    function render() {
        if (!on) return;
        if (!D()) { acts = []; paint('pvBody', '<div class="pv-card pv-note">Conectando con el juego…</div>'); return; }
        acts = [];
        var tt = titles();
        $('pvTitle').textContent = tt[0];
        $('pvSub').textContent = tt[1];
        renderTimer();
        paint('pvBody', bodyHtml());
        var p = primary(), a = '';
        var d = D();
        if (d.phase === 'question' && S.colaPulsador.length && (BUZZ.has(type()) || type() === 'pictionary')) {
            a += '<div class="pv-okko">' + btn('&#10004; Acierto', function () { markFirst(true); }, 'btn-success') + btn('&#10008; Fallo', function () { markFirst(false); }, 'btn-danger') + '</div>';
        }
        a += '<div class="pv-sec">' + secondary() + '</div>';
        if (p) a += p.idle ? '<button class="pv-primary idle" disabled>' + p.text + '</button>' : btn(p.text, p.fn, 'pv-primary ' + p.cls);
        var txt = p && !p.idle ? p.text : '';
        // El bloqueo tras un toque dura hasta que llega el estado nuevo (el botón cambia), con 0,7 s de
        // mínimo y 3 s de máximo: con wifi lenta, dos toques a «Cerrar» en Letras se saltaban la corrección
        if (lockUntil && txt !== lockText && Date.now() - lockAt >= 700) lockUntil = 0;
        paint('pvActions', a);
        // Destello y bloqueo sobre el botón que hay, sin meterlos en el HTML (si no, repintaba y se comía toques)
        var pb = $('pvActions').querySelector('.pv-primary:not(.idle)');
        if (pb) {
            pb.classList.toggle('locked', Date.now() < lockUntil);
            if (txt !== lastPrimary && lastPrimary) { pb.classList.remove('flash'); void pb.offsetWidth; pb.classList.add('flash'); }
        }
        lastPrimary = txt;
        if (sheet && !dragging) renderSheet();
    }

    function renderTimer() {
        if (!on) return;
        var src = $('timerDisplay'), el = $('pvTimer');
        var off = src.textContent === '--:--' || !D() || D().phase !== 'question';
        el.textContent = src.textContent.replace(/^0(\d:)/, '$1');
        el.className = 'pv-timer' + (off ? ' off' : '') + (/danger/.test(src.className) ? ' danger' : /running/.test(src.className) ? ' running' : '');
    }

    // ── Hojas: escaleta, más, puntos ──
    function openSheet(name) { sheet = name; $('pvSheet').classList.add('on'); painted.pvSheetBody = null; renderSheet(); }
    function closeSheet() { sheet = null; $('pvSheet').classList.remove('on'); }

    function renderSheet() {
        var d = D(), html = '';
        if (!d) { $('pvSheetTitle').textContent = ''; $('pvSheetSub').textContent = ''; paint('pvSheetBody', '<div class="pv-card pv-note">Conectando…</div>'); return; }
        if (sheet === 'more') {
            $('pvSheetTitle').textContent = 'Más'; $('pvSheetSub').textContent = '';
            var b = function (ic, text, fn, active) { return btn('<span class="ic">' + ic + '</span>' + text, fn, 'btn-ghost' + (active ? ' on' : '')); };
            html = '<div class="pv-more">'
                + b('&#127942;', 'Ranking en pantalla', toggleScoreboard, d.scoreboardVisible)
                + b('&#127968;', 'Home', function () { emit('director:show_home'); closeSheet(); })
                + b('&#9208;', 'Espera', function () { emit('director:show_waiting'); closeSheet(); })
                + b('&#128241;', 'QR en pantalla', function () { emit('director:toggle_qr'); }, d.qrVisible)
                + b('&#127925;', 'Música', function () { closeSheet(); openMusic(); })
                + b('&#10133;', 'Puntos y equipos', function () { openSheet('pts'); })
                + b('&#127873;', 'Anuncio de bono', function () { emit('director:toggle_premio_anuncio'); }, d.premioAnuncioVisible)
                + b('&#127941;', 'Ganador del bono', function () { emit('director:toggle_premio_ganador'); }, d.premioGanadorVisible)
                + (inQuestion() ? b('&#128736;', 'Panel de la prueba', panelOn) : '')
                + b('&#128421;', 'Control completo', exit)
                + '</div><div class="pv-note">Lo delicado (reiniciar puntos, borrar todo, expulsar equipos) solo está en el control completo.</div>';
        } else if (sheet === 'fix') {
            $('pvSheetTitle').textContent = 'Rectificar';
            $('pvSheetSub').textContent = 'Cada cambio recalcula los puntos al momento';
            html = d.phase === 'answer_revealed' ? correctionHtml(true) : '<div class="pv-card pv-note">Ya no hay nada que rectificar.</div>';
        } else if (sheet === 'pts') {
            $('pvSheetTitle').textContent = 'Puntos y equipos'; $('pvSheetSub').textContent = 'Sumar, restar o congelar';
            html = '<div class="pv-card"><div class="pv-rows">' + ranking().map(function (r) {
                var e = r.team;
                return '<div class="pv-row"><span class="dot' + (e.ocupado ? ' on' : '') + '"></span><span class="nm">' + (e.bloqueado ? '&#10052; ' : '') + esc(e.nombre) + '</span><span class="pt">' + r.pts + '</span>'
                    + btn('+', function (ev) { openQuickPoints(e.id, 'add', ev.currentTarget); }, 'btn-success')
                    + btn('&minus;', function (ev) { openQuickPoints(e.id, 'sub', ev.currentTarget); }, 'btn-danger')
                    + btn(e.bloqueado ? '&#128275;' : '&#10052;', function () { toggleBlock(e.id, !!e.bloqueado); }, 'btn-ghost') + '</div>';
            }).join('') + '</div></div>';
            if (!S.equipos.length) html = '<div class="pv-card pv-note">Sin equipos.</div>';
        } else if (sheet === 'esc') {
            $('pvSheetTitle').textContent = 'Escaleta';
            var done = d.completedRounds || [], nx = GSNextStep.nextRound(d, S.rounds);
            $('pvSheetSub').textContent = done.length + ' de ' + S.rounds.length + ' rondas jugadas';
            if (inQuestion() || d.phase === 'round_intro') {
                html += '<div class="pv-card"><h3>Preguntas de «' + esc((d.currentRound && d.currentRound.name) || '') + '»</h3><div class="pv-qs">'
                    + (d.questions || []).map(function (q, i) {
                        // jumpToQuestion: avisa si la actual tiene respuestas sin revelar (se perderían)
                        return btn(String(i + 1), function () { jumpToQuestion(i); closeSheet(); }, i === d.currentQuestionIdx && inQuestion() ? 'cur' : '');
                    }).join('') + '</div></div>';
            }
            html += '<div class="pv-esc" id="pvEsc">' + S.rounds.map(function (r, i) {
                var cur = r.id === d.currentRoundId && d.phase !== 'lobby' && d.phase !== 'waiting';
                var isDone = done.indexOf(r.id) >= 0;
                var tag = cur ? '<span class="pv-tag cur">En curso</span>' : nx && nx.id === r.id ? '<span class="pv-tag next">Siguiente</span>' : isDone ? '<span class="pv-tag done">✓ Jugada</span>' : '';
                return '<div class="pv-er' + (cur ? ' cur' : '') + (isDone && !cur ? ' done' : '') + '" data-id="' + esc(r.id) + '">'
                    + '<span class="pv-grip" aria-label="Arrastrar para cambiar el orden">&#10303;</span>'
                    + btn('<span class="num">' + (i + 1) + '</span><span class="txt"><b>' + esc(r.name) + '</b><small>' + esc(label(r.type)) + ' · ' + (r.questions || []).length + ' preg.</small></span>' + tag,
                        function () { launchRound(r.id); closeSheet(); }, 'pv-er-go')
                    + '</div>';
            }).join('') + '</div>'
                + '<div class="pv-note">Toca una ronda para lanzarla. Arrastra &#10303; para cambiar el orden: se guarda en el juego y lo ven todos los coordinadores.</div>'
                + '<div class="pv-sec">' + btn('&#127968; Ir al Home', function () { emit('director:show_home'); closeSheet(); }) + '</div>';
        }
        if (paint('pvSheetBody', html) && sheet === 'esc') makeSortable($('pvEsc'), '.pv-er', '.pv-grip', saveOrder);
    }

    // ── Ordenar arrastrando (escaleta del presentador y barra «Rondas» del coordinador) ──
    // Con eventos de puntero sobre el asa: vale con el dedo y con el ratón. Como en el backoffice:
    // la fila se queda en su sitio medio transparente, una copia translúcida sigue al dedo y una raya
    // azul marca dónde caerá. Las filas no se mueven hasta soltar. Al soltar, onDrop(ids).
    function makeSortable(list, rowSel, gripSel, onDrop) {
        if (!list) return;
        list.querySelectorAll(gripSel).forEach(function (grip) {
            grip.addEventListener('click', function (ev) { ev.stopPropagation(); });
            grip.addEventListener('pointerdown', function (ev) {
                var row = grip.closest(rowSel);
                if (!row) return;
                ev.preventDefault(); ev.stopPropagation();
                var scroller = list.closest('.pv-sheet-body') || list.closest('.rounds-list') || list;
                var rr = row.getBoundingClientRect(), offY = ev.clientY - rr.top;
                var ghost = row.cloneNode(true);
                ghost.classList.remove('dragging');
                ghost.style.cssText = 'position:fixed;left:' + rr.left + 'px;top:' + rr.top + 'px;width:' + rr.width + 'px;height:' + rr.height + 'px;margin:0;'
                    + 'background:var(--surface2,#1e1e3a);border:1px solid var(--accent,#00d4ff);border-radius:10px;'
                    + 'opacity:.75;pointer-events:none;z-index:9999;box-shadow:0 10px 30px rgba(0,0,0,.55);transform:scale(1.02);transition:none';
                var line = document.createElement('div');
                line.style.cssText = 'position:fixed;height:4px;border-radius:2px;background:var(--accent,#00d4ff);box-shadow:0 0 10px var(--accent,#00d4ff);pointer-events:none;z-index:9998;display:none';
                document.body.appendChild(line); document.body.appendChild(ghost);
                dragging = true;
                row.classList.add('sort-src');
                var pid = ev.pointerId, drop = null, startY = ev.clientY, lastY = ev.clientY, timer = null, moved = false;
                // Dónde caería con el dedo en «y»: delante de la fila cuya mitad queda por debajo (o al final)
                function place(y) {
                    var rows = list.querySelectorAll(rowSel), lr = list.getBoundingClientRect(), target = null;
                    for (var i = 0; i < rows.length; i++) { var rc = rows[i].getBoundingClientRect(); if (y < rc.top + rc.height / 2) { target = rows[i]; break; } }
                    drop = target;
                    // Sin cambio real (justo delante o detrás de sí misma): sin raya
                    var same = target === row || target === row.nextElementSibling || (!target && row === rows[rows.length - 1]);
                    var ref = target ? target.getBoundingClientRect() : rows[rows.length - 1].getBoundingClientRect();
                    var ly = target ? ref.top - 3 : ref.bottom + 1;
                    var sr = scroller.getBoundingClientRect();
                    if (same || ly < sr.top - 4 || ly > sr.bottom + 4) { line.style.display = 'none'; return; }
                    line.style.display = ''; line.style.left = lr.left + 'px'; line.style.width = lr.width + 'px'; line.style.top = ly + 'px';
                }
                // Cerca del borde de la lista, se desplaza sola aunque el dedo no se mueva
                function autoScroll() {
                    var sr = scroller.getBoundingClientRect(), d = 0;
                    if (lastY < sr.top + 50) d = -12; else if (lastY > sr.bottom - 50) d = 12;
                    if (d) { scroller.scrollTop += d; place(lastY); }
                }
                // Se escucha en la página entera (el dedo sale del asa enseguida)
                function move(e) {
                    if (e.pointerId !== pid) return;
                    e.preventDefault();
                    lastY = e.clientY;
                    ghost.style.top = (e.clientY - offY) + 'px';
                    // Hasta que no se mueve de verdad no hay raya ni desplazamiento (dejar el dedo quieto no mueve nada)
                    if (!moved && Math.abs(e.clientY - startY) < 8) return;
                    if (!moved) { moved = true; timer = setInterval(autoScroll, 30); }
                    place(e.clientY);
                }
                function up(e) {
                    if (e.pointerId !== pid) return;
                    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
                    clearInterval(timer);
                    ghost.remove(); line.remove();
                    row.classList.remove('sort-src');
                    dragging = false;
                    var before = ids();
                    if (moved && e.type === 'pointerup' && line.style.display !== 'none' && drop !== row && row.isConnected && (!drop || drop.parentNode === list)) {
                        if (drop) list.insertBefore(row, drop); else list.appendChild(row);
                    }
                    // Con ratón, soltar sobre la fila genera un clic que la lanzaría (barra «Rondas»): se anula
                    if (moved) {
                        var eat = function (c) { c.stopPropagation(); c.preventDefault(); };
                        window.addEventListener('click', eat, true);
                        setTimeout(function () { window.removeEventListener('click', eat, true); }, 0);
                    }
                    var after = ids();
                    if (after.join() !== before.join()) onDrop(after);
                    else if (sheet) renderSheet();
                }
                window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
            });
        });
        function ids() { return Array.prototype.map.call(list.querySelectorAll(rowSel), function (r) { return r.dataset.id; }); }
    }

    // Guarda el orden nuevo (la misma llamada que el backoffice); el servidor avisa a todos los
    // coordinadores (game:rounds_changed → reloadRounds) y la escaleta se repinta sola.
    function saveOrder(order) {
        var prev = S.rounds.slice();
        var byId = {};
        S.rounds.forEach(function (r) { byId[r.id] = r; });
        S.rounds = order.map(function (id) { return byId[id]; }).filter(Boolean);
        renderRounds();
        render();
        fetch('/api/games/' + S.gameId + '/rounds/reorder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: order }) })
            .then(function (r) { if (!r.ok) throw new Error(); toast('Escaleta guardada'); })
            .catch(function () { S.rounds = prev; renderRounds(); render(); toast('No se ha podido guardar el orden'); });
    }

    // ── Entrar / salir ──
    function enter() {
        on = true;
        document.body.classList.add('pv-on');
        try { localStorage.setItem(KEY, '1'); } catch (e) {}
        keepAwake();
        painted = {};
        render();
    }
    function exit() {
        on = false; closeSheet();
        document.body.classList.remove('pv-on', 'pv-panel');
        try { localStorage.removeItem(KEY); } catch (e) {}
        if (wake) { try { wake.release(); } catch (e) {} wake = null; }
    }
    // Pantalla siempre encendida (solo con https: en el kit, por http://IP, el navegador no lo deja)
    function keepAwake() {
        if (!on || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
        navigator.wakeLock.request('screen').then(function (w) { wake = w; }).catch(function () {});
    }
    document.addEventListener('visibilitychange', keepAwake);

    // ── Toques ──
    function onTap(ev) {
        var el = ev.target.closest('[data-a]');
        if (!el || el.disabled) return;
        var a = el.dataset.a;
        if (a === 'act') {
            var zone = el.closest('#pvBody, #pvActions, #pvSheetBody');
            var fn = zone && zoneActs[zone.id] && zoneActs[zone.id][+el.dataset.i];
            if (!fn) return;
            if (el.classList.contains('pv-primary') || el.closest('.pv-okko')) {
                // El botón grande cambia de texto tras cada toque: un doble toque no se salta dos pasos
                if (Date.now() < lockUntil) return;
                lockAt = Date.now(); lockUntil = lockAt + 3000; lockText = lastPrimary;
                el.classList.add('locked');
                setTimeout(render, 720); setTimeout(render, 3020); // quitar el bloqueo si ya llegó el estado nuevo (o al tope)
            }
            fn.call(el, { currentTarget: el });
        }
        else if (a === 'sheet') openSheet(el.dataset.s);
        else if (a === 'close') closeSheet();
        else if (a === 'panel-off') panelOff();
        else if (a === 'timer') {
            // Tocar el crono lo para o lo arranca (como ▶ / ■ del coordinador)
            if (/running|danger/.test($('timerDisplay').className)) emit('director:stop_timer');
            else if (!$('btnStartTimer').disabled) emit('director:start_timer');
        }
    }
    root.addEventListener('click', onTap);
    back.addEventListener('click', onTap);

    var want = false;
    try { want = /[?&]presentador=1/.test(location.search) || localStorage.getItem(KEY) === '1'; } catch (e) {}

    return { enter: enter, exit: exit, render: render, renderTimer: renderTimer, makeSortable: makeSortable, saveOrder: saveOrder, isOn: function () { return on; }, autoStart: function () { if (want) enter(); } };
})();
