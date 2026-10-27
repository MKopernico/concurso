// Diccionario de la prueba «Letras» (solo en el servidor): data/letras/palabras.txt, generado de
// RLA-ES con tools/letras/build-palabras.js (ver data/letras/LEEME.txt). Se carga la primera vez
// que hace falta (~100.000 palabras, unos MB de memoria).
//   has(palabra)            → forma con tilde para enseñar ('canción') o null si no está
//   best(letras, n)         → las palabras más largas que se pueden formar ({ len, words })
//   generate(n, rnd)        → letras al azar (frecuencias del castellano) con buena palabra posible
const fs = require('fs');
const path = require('path');
const Letras = require('./public/shared/letras.js');

const FILE = path.join(__dirname, 'data', 'letras', 'palabras.txt');
let _dict = null;   // Map normalizada → forma con tilde ('' si es igual)
let _list = null;   // [normalizada] para buscar las mejores

function load() {
    if (_dict) return _dict;
    _dict = new Map();
    let text = '';
    try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) { console.error('[letras] no se pudo leer el diccionario:', e.message); }
    for (const line of text.split(/\r?\n/)) { // en Windows Git lo deja con CRLF
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab < 0) _dict.set(line, '');
        else _dict.set(line.slice(0, tab), line.slice(tab + 1));
    }
    _list = [..._dict.keys()];
    return _dict;
}
function size() { return load().size; }
function has(word) {
    const n = Letras.normWord(word);
    const d = load();
    if (!n || !d.has(n)) return null;
    return d.get(n) || n;
}
function display(n) { const d = load(); return (d.has(n) && d.get(n)) || n; }

// Las palabras más largas que se pueden formar (y cuántas hay de esa longitud)
function best(letters, limit) {
    load();
    const counts = new Map();
    letters.forEach(c => { const k = c === 'Ñ' ? 'ñ' : c.toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); });
    let bestLen = 0, words = [];
    const tmp = new Map();
    for (const w of _list) {
        if (w.length < bestLen || w.length > letters.length) continue;
        tmp.clear();
        let ok = true;
        for (const ch of w) {
            const c = (tmp.get(ch) || 0) + 1;
            if (c > (counts.get(ch) || 0)) { ok = false; break; }
            tmp.set(ch, c);
        }
        if (!ok) continue;
        if (w.length > bestLen) { bestLen = w.length; words = []; }
        words.push(w);
    }
    return { len: bestLen, count: words.length, words: words.slice(0, limit || 6).map(display) };
}

// Frecuencia aproximada de cada letra en castellano (sin K ni W, que casi no dan palabras)
const WV = { A: 12.5, E: 13.7, I: 6.2, O: 8.7, U: 3.9 };
const WC = { S: 8.0, R: 6.9, N: 6.7, D: 5.9, L: 5.0, C: 4.7, T: 4.6, M: 3.2, P: 2.5, B: 1.4, G: 1.0, V: 0.9, Y: 0.9, Q: 0.6, H: 0.7, F: 0.7, Z: 0.5, J: 0.4, Ñ: 0.3, X: 0.2 };
function pickWeighted(table, rnd, counts, maxEach) {
    const keys = Object.keys(table).filter(k => (counts[k] || 0) < maxEach);
    let total = keys.reduce((a, k) => a + table[k], 0), x = rnd() * total;
    for (const k of keys) { x -= table[k]; if (x <= 0) return k; }
    return keys[keys.length - 1];
}
// n letras (4-12): algo menos de la mitad vocales; cada letra como mucho dos veces; la Q solo con U.
// Se repite hasta que la mejor palabra tenga al menos n-2 letras (n-1 con pocas letras).
function generate(n, rnd) {
    n = Math.max(4, Math.min(12, Math.round(Number(n) || 9)));
    rnd = rnd || Math.random;
    const need = n <= 6 ? n - 1 : n - 2;
    let fallback = null;
    for (let tries = 0; tries < 80; tries++) {
        const nv = Math.max(2, Math.round(n * 0.42) + (rnd() < 0.3 ? 1 : 0) - (rnd() < 0.2 ? 1 : 0));
        const counts = {}, letters = [];
        for (let i = 0; i < nv; i++) { const v = pickWeighted(WV, rnd, counts, 2); counts[v] = (counts[v] || 0) + 1; letters.push(v); }
        while (letters.length < n) { const c = pickWeighted(WC, rnd, counts, 2); counts[c] = (counts[c] || 0) + 1; letters.push(c); }
        if (counts.Q && !counts.U) { letters[letters.indexOf('Q')] = 'R'; }
        // Barajadas: que las vocales no salgan todas juntas
        for (let i = letters.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [letters[i], letters[j]] = [letters[j], letters[i]]; }
        const b = best(letters, 6);
        if (!fallback || b.len > fallback.best.len) fallback = { letters, best: b };
        if (b.len >= need) return { letters, best: b };
    }
    return fallback;
}

module.exports = { load, size, has, best, generate };
