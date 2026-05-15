/* ═══════════════════════════════════════════════════════════════
   GameShow — Shared Transition & Animation Module
   Include via <script src="/shared/gameshow-transitions.js"></script>
   Requires gameshow-transitions.css loaded beforehand.
   ═══════════════════════════════════════════════════════════════ */
(function() {
'use strict';

// ═══════════════ TRANSITIONS ═══════════════

/**
 * Crossfade between two phase elements.
 * Steps: fade out old (300ms) → swap active class → fade in new (300ms)
 * @param {Element} outEl   - element to fade out (can be null)
 * @param {Element} inEl    - element to fade in (can be null)
 * @param {number}  dur     - half-duration in ms (default 300)
 * @param {Function} onMid  - called at midpoint (content swap)
 * @param {Function} onDone - called when fade-in finishes
 */
function crossfade(outEl, inEl, dur, onMid, onDone) {
    dur = dur || 300;
    if (outEl === inEl) { if (onMid) onMid(); if (onDone) onDone(); return; }

    // Fade out
    if (outEl) {
        outEl.style.transition = 'opacity ' + dur + 'ms ease';
        outEl.style.opacity = '0';
    }

    setTimeout(function() {
        if (outEl) {
            outEl.classList.remove('active');
            outEl.style.transition = '';
            outEl.style.opacity = '';
        }
        if (onMid) onMid();
        if (inEl) {
            inEl.style.opacity = '0';
            inEl.classList.add('active');
            void inEl.offsetHeight; // force reflow
            inEl.style.transition = 'opacity ' + dur + 'ms ease';
            inEl.style.opacity = '1';
            setTimeout(function() {
                inEl.style.transition = '';
                inEl.style.opacity = '';
                if (onDone) onDone();
            }, dur);
        } else {
            if (onDone) onDone();
        }
    }, outEl ? dur : 0);
}


// ═══════════════ ANIMATIONS: MULTIRESPUESTA ═══════════════

/**
 * Animate options appearing one by one from below.
 * Call this after rendering option HTML into the container.
 * @param {Element} container  - the options wrapper
 * @param {string}  selector   - child selector (e.g. '.q-opt')
 * @param {number}  delayMs    - stagger delay between each (default 120)
 */
function staggerOptions(container, selector, delayMs) {
    if (!container) return;
    delayMs = delayMs || 120;
    var children = container.querySelectorAll(selector);
    children.forEach(function(el, i) {
        el.classList.remove('gs-opt-enter');
        el.style.animationDelay = (i * delayMs) + 'ms';
        void el.offsetHeight;
        el.classList.add('gs-opt-enter');
    });
}

/**
 * Animate the statement sliding up when options appear.
 * @param {Element} statementEl - the statement element
 * @param {string}  transform   - CSS transform value (e.g. 'translateY(-60px)')
 */
function liftStatement(statementEl, transform) {
    if (!statementEl) return;
    statementEl.classList.add('gs-statement-lifted');
    statementEl.style.transform = transform || 'translateY(-40px)';
}

/**
 * Reset statement position (e.g. for new question).
 * @param {Element} statementEl
 */
function resetStatement(statementEl) {
    if (!statementEl) return;
    statementEl.classList.remove('gs-statement-lifted', 'gs-statement-enter');
    statementEl.style.transform = '';
}

/**
 * Animate statement fade-in entrance.
 * @param {Element} statementEl
 */
function enterStatement(statementEl) {
    if (!statementEl) return;
    statementEl.classList.remove('gs-statement-enter');
    void statementEl.offsetHeight;
    statementEl.classList.add('gs-statement-enter');
}

/**
 * Animate answer reveal: glow correct, dim wrong.
 * @param {Element} container       - options container
 * @param {string}  correctSelector - CSS selector for correct options
 * @param {string}  wrongSelector   - CSS selector for wrong options
 */
function revealAnswer(container, correctSelector, wrongSelector) {
    if (!container) return;
    var corrects = container.querySelectorAll(correctSelector);
    var wrongs = container.querySelectorAll(wrongSelector);
    corrects.forEach(function(el) {
        el.classList.add('gs-correct-glow');
    });
    wrongs.forEach(function(el) {
        el.classList.add('gs-wrong-dim');
    });
}

/**
 * Clear all animation classes from options.
 * @param {Element} container
 * @param {string}  selector
 */
function clearAnimations(container, selector) {
    if (!container) return;
    var children = container.querySelectorAll(selector || '*');
    children.forEach(function(el) {
        el.classList.remove('gs-opt-enter', 'gs-correct-glow', 'gs-wrong-dim', 'gs-statement-enter');
        el.style.animationDelay = '';
    });
}


// ═══════════════ THEME RESOLVER ═══════════════

/**
 * Resolve theme inheritance: round → type → game → defaults.
 * @param {Object} gameTheme  - game-level theme
 * @param {Object} roundConfig - round config (parsed JSON)
 * @param {string} roundType  - round type name
 * @returns {Object} resolved theme { background, logo, ipadBackground, waitingImage }
 */
function resolveTheme(gameTheme, roundConfig, roundType) {
    var gt = gameTheme || {};
    var rc = roundConfig || {};
    var typeTheme = (gt.types && gt.types[roundType]) || {};

    return {
        background: rc.background || typeTheme.background || null,
        logo: rc.logo || typeTheme.logo || null,
        waitingImage: gt.waitingImage || null,
        ipadBackground: gt.ipadBackground || 'black', // 'black' | 'color' | 'round'
        ipadBackgroundColor: gt.ipadBackgroundColor || null,
    };
}


// ═══════════════ SCOREBOARD RENDERER ═══════════════

/**
 * Render scoreboard HTML content (no overlay logic, just the table).
 * @param {Array} equipos   - team objects [{id, nombre, photo_url}]
 * @param {Object} scores   - {teamId: score}
 * @param {Object} opts     - { myTeamId, mode: 'screen'|'player'|'director' }
 * @returns {string} HTML
 */
function renderScoreboardHTML(equipos, scores, opts) {
    opts = opts || {};
    var rows = (equipos || []).map(function(e) {
        return { id: e.id, name: e.nombre, photo_url: e.photo_url, score: (scores || {})[e.id] || 0 };
    });
    rows.sort(function(a, b) { return b.score - a.score; });

    var maxScore = rows.length > 0 ? Math.max(rows[0].score, 1) : 1;
    var trophies = ['\u{1F3C6}', '\u{1F948}', '\u{1F949}'];
    var mode = opts.mode || 'screen';

    if (mode === 'screen') {
        return rows.map(function(r, i) {
            var pct = (r.score / maxScore) * 100;
            var photoHtml = r.photo_url
                ? '<img src="' + _esc(r.photo_url) + '" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;">'
                : '<div style="width:48px;height:48px;border-radius:50%;background:var(--surface2,#1e1e2e);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">\u{1F464}</div>';
            return '<div class="sb-row" style="animation-delay:' + (i * 0.1) + 's">' +
                '<div class="sb-pos">' + (i < 3 ? trophies[i] : (i + 1)) + '</div>' +
                photoHtml +
                '<div class="sb-name">' + _esc(r.name) + '</div>' +
                '<div class="sb-bar"><div class="sb-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<div class="sb-score">' + r.score + '</div></div>';
        }).join('');
    } else if (mode === 'player') {
        return rows.map(function(r, i) {
            var isMe = r.id === opts.myTeamId;
            return '<tr class="' + (isMe ? 'sb-me' : '') + '">'
                + '<td class="sb-rank">' + (i < 3 ? trophies[i] : (i + 1)) + '</td>'
                + '<td>' + _esc(r.name) + (isMe ? ' (tu)' : '') + '</td>'
                + '<td class="sb-score">' + r.score + '</td></tr>';
        }).join('');
    } else { // director
        return rows.map(function(r, i) {
            return '<tr><td class="rank">' + (i === 0 ? '\u{1F3C6}' : (i + 1)) + '</td>'
                + '<td>' + _esc(r.name) + '</td><td class="score">' + r.score + '</td></tr>';
        }).join('');
    }
}

function _esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }


// ═══════════════ EXPORTS ═══════════════
window.GameShowShared = {
    Transitions: {
        crossfade: crossfade,
    },
    Animations: {
        staggerOptions: staggerOptions,
        liftStatement: liftStatement,
        resetStatement: resetStatement,
        enterStatement: enterStatement,
        revealAnswer: revealAnswer,
        clearAnimations: clearAnimations,
    },
    Theme: {
        resolve: resolveTheme,
    },
    Scoreboard: {
        renderHTML: renderScoreboardHTML,
    },
    _esc: _esc,
};

})();
