/**
 * RoulettePanel — componente visual reutilizable para "Ruleta de la Suerte".
 * Se usa en /screen, /play y /director con la misma lógica de layout.
 *
 * API:
 *   RoulettePanel.render(container, { phrase, hint, revealedLetters, logo, size, panelVisible })
 *   RoulettePanel.revealLetter(container, letter)   — anima flip de una letra
 *   RoulettePanel.solveAll(container, phrase)        — revela todo con stagger
 */
(function (root) {
    'use strict';

    var VOWELS = 'AEIOUÁÉÍÓÚÜ';
    var PUNCTUATION = ',.!?¡¿:;—–-\'\"()';

    function isLetter(ch) {
        return ch !== ' ' && PUNCTUATION.indexOf(ch) === -1;
    }

    function isVowel(ch) {
        return VOWELS.indexOf(ch.toUpperCase()) >= 0;
    }

    function uniqueLetters(phrase) {
        var set = {};
        for (var i = 0; i < phrase.length; i++) {
            var ch = phrase[i].toUpperCase();
            if (isLetter(phrase[i])) set[ch] = true;
        }
        return Object.keys(set);
    }

    function pendingLetters(phrase, revealedLetters) {
        var all = uniqueLetters(phrase);
        var revSet = {};
        for (var i = 0; i < revealedLetters.length; i++) revSet[revealedLetters[i].toUpperCase()] = true;
        var consonants = [], vowels = [];
        for (var j = 0; j < all.length; j++) {
            if (revSet[all[j]]) continue;
            if (isVowel(all[j])) vowels.push(all[j]);
            else consonants.push(all[j]);
        }
        consonants.sort();
        vowels.sort();
        return { consonants: consonants, vowels: vowels };
    }

    /** Split phrase into words, keeping punctuation attached to adjacent letters */
    function splitIntoTokens(phrase) {
        var tokens = []; // each token: { type: 'word'|'space', chars: [{ch, isLetter, isPunct}] }
        var current = null;
        for (var i = 0; i < phrase.length; i++) {
            var ch = phrase[i];
            if (ch === ' ') {
                if (current) { tokens.push(current); current = null; }
                tokens.push({ type: 'space', chars: [] });
            } else {
                if (!current) current = { type: 'word', chars: [] };
                current.chars.push({ ch: ch, isLetter: isLetter(ch), isPunct: PUNCTUATION.indexOf(ch) >= 0 });
            }
        }
        if (current) tokens.push(current);
        return tokens;
    }

    /** Distribute word-tokens into rows. Max maxPerRow letter-cells per row. */
    function distributeRows(tokens, maxPerRow) {
        var rows = [];
        var currentRow = [];
        var currentCount = 0; // letter cells in current row

        for (var i = 0; i < tokens.length; i++) {
            var tok = tokens[i];
            if (tok.type === 'space') {
                currentRow.push(tok);
                continue;
            }
            var letterCount = 0;
            for (var j = 0; j < tok.chars.length; j++) { if (tok.chars[j].isLetter) letterCount++; }

            if (currentCount > 0 && currentCount + letterCount > maxPerRow) {
                // Remove trailing spaces from current row
                while (currentRow.length && currentRow[currentRow.length - 1].type === 'space') currentRow.pop();
                rows.push(currentRow);
                currentRow = [];
                currentCount = 0;
            }
            currentRow.push(tok);
            currentCount += letterCount;
        }
        if (currentRow.length) {
            while (currentRow.length && currentRow[currentRow.length - 1].type === 'space') currentRow.pop();
            rows.push(currentRow);
        }
        return rows;
    }

    function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

    function isRevealed(ch, revealedLetters) {
        if (!isLetter(ch)) return true; // punctuation always shown
        var upper = ch.toUpperCase();
        for (var i = 0; i < revealedLetters.length; i++) {
            if (revealedLetters[i].toUpperCase() === upper) return true;
        }
        return false;
    }

    /**
     * Render the full roulette panel into a container element.
     * @param {HTMLElement} container
     * @param {Object} opts
     * @param {string} opts.phrase
     * @param {string} opts.hint
     * @param {string[]} opts.revealedLetters — uppercase letters revealed
     * @param {string} [opts.logo] — URL for round logo
     * @param {'large'|'medium'|'small'} [opts.size] — cell sizing: large=screen, medium=director, small=play
     * @param {boolean} [opts.panelVisible] — if false, panel is hidden (opacity:0)
     * @param {boolean} [opts.solved] — if true, all revealed
     */
    function render(container, opts) {
        var phrase = (opts.phrase || '').toUpperCase();
        var hint = opts.hint || '';
        var revealed = opts.revealedLetters || [];
        var logo = opts.logo || null;
        var size = opts.size || 'large';
        var panelVisible = opts.panelVisible !== false;
        var solved = opts.solved || false;

        if (solved) {
            // All letters are revealed
            revealed = uniqueLetters(phrase);
        }

        var pending = pendingLetters(phrase, revealed);
        var tokens = splitIntoTokens(phrase);
        var maxPerRow = size === 'small' ? 10 : 12;
        var rows = distributeRows(tokens, maxPerRow);

        var cellClass = 'rp-cell rp-cell-' + size;

        // Build HTML
        var html = '';

        // Background decoration
        html += '<div class="rp-bg">';
        html += '<div class="rp-bg-top"></div>';
        html += '<div class="rp-bg-wave"></div>';
        html += '</div>';

        // Logo
        if (logo) {
            html += '<div class="rp-logo"><img src="' + esc(logo) + '" onerror="this.style.display=\'none\'"></div>';
        }

        // Info bar: hint + pending letters
        html += '<div class="rp-info">';
        html += '<div class="rp-hint"><span class="rp-hint-label">Pista:</span> ' + esc(hint) + '</div>';
        html += '<div class="rp-pending">';
        if (pending.consonants.length) html += '<span class="rp-pending-cons">' + pending.consonants.join(' ') + '</span>';
        if (pending.vowels.length) html += '<span class="rp-pending-vowels">' + pending.vowels.join(' ') + '</span>';
        if (!pending.consonants.length && !pending.vowels.length) html += '<span class="rp-pending-done">Todas reveladas</span>';
        html += '</div>';
        html += '</div>';

        // Letter grid
        html += '<div class="rp-grid">';
        for (var r = 0; r < rows.length; r++) {
            html += '<div class="rp-row">';
            var row = rows[r];
            for (var t = 0; t < row.length; t++) {
                var tok = row[t];
                if (tok.type === 'space') {
                    html += '<div class="rp-space"></div>';
                    continue;
                }
                html += '<div class="rp-word">';
                for (var ci = 0; ci < tok.chars.length; ci++) {
                    var charObj = tok.chars[ci];
                    if (charObj.isPunct) {
                        html += '<div class="rp-punct">' + esc(charObj.ch) + '</div>';
                    } else {
                        var rev = isRevealed(charObj.ch, revealed);
                        html += '<div class="' + cellClass + (rev ? ' revealed' : ' hidden') + '" data-letter="' + charObj.ch.toUpperCase() + '">';
                        html += rev ? '<span class="rp-char">' + esc(charObj.ch) + '</span>' : '';
                        html += '</div>';
                    }
                }
                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div>';

        container.innerHTML = html;
        container.className = (container.className.replace(/\brp-container\b/g, '').trim() + ' rp-container').trim();
        container.style.opacity = panelVisible ? '1' : '0';
        container.style.transition = 'opacity 0.6s ease';
    }

    /** Animate reveal of a single letter across all matching cells */
    function revealLetter(container, letter) {
        var upper = letter.toUpperCase();
        var cells = container.querySelectorAll('.rp-cell.hidden[data-letter="' + upper + '"]');
        for (var i = 0; i < cells.length; i++) {
            (function (cell, delay) {
                setTimeout(function () {
                    cell.classList.remove('hidden');
                    cell.classList.add('revealed', 'rp-flip');
                    cell.innerHTML = '<span class="rp-char">' + esc(upper) + '</span>';
                }, delay);
            })(cells[i], i * 80);
        }
        // Update pending bar
        updatePending(container);
    }

    /** Reveal all letters with staggered animation */
    function solveAll(container, phrase) {
        var cells = container.querySelectorAll('.rp-cell.hidden');
        for (var i = 0; i < cells.length; i++) {
            (function (cell, delay) {
                setTimeout(function () {
                    var letter = cell.getAttribute('data-letter');
                    cell.classList.remove('hidden');
                    cell.classList.add('revealed', 'rp-flip');
                    cell.innerHTML = '<span class="rp-char">' + esc(letter) + '</span>';
                }, delay);
            })(cells[i], i * 50);
        }
        updatePending(container);
    }

    function updatePending(container) {
        var pending = container.querySelector('.rp-pending');
        if (!pending) return;
        var hiddenCells = container.querySelectorAll('.rp-cell.hidden');
        if (hiddenCells.length === 0) {
            pending.innerHTML = '<span class="rp-pending-done">Todas reveladas</span>';
        }
    }

    // Export
    root.RoulettePanel = {
        render: render,
        revealLetter: revealLetter,
        solveAll: solveAll,
        pendingLetters: pendingLetters,
        uniqueLetters: uniqueLetters,
        isLetter: isLetter
    };
})(window);
