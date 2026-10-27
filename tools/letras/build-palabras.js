// Genera data/letras/palabras.txt (lista de palabras de la prueba «Letras») a partir del
// diccionario hunspell es_ES de RLA-ES (https://github.com/sbosio/rla-es, MPL 1.1 / GPL 3 / LGPL 3).
//
//   node tools/letras/build-palabras.js <es-ES.dic> <es-ES.aff>
//
// Qué entra: las entradas del diccionario (en minúscula: sin nombres propios ni siglas) y, de
// ellas, solo los plurales (regla S) y los femeninos (regla G). Las demás reglas (conjugaciones,
// diminutivos, prefijos, derivados) no se aplican: «comer» vale, «comían» no.
// Formato: una palabra por línea, ya normalizada para el juego (sin tildes ni diéresis; la ñ se
// queda). Si se escribe con tilde, detrás va un tabulador y la forma con tilde (para enseñarla).
const fs = require('fs');
const path = require('path');

const [dicPath, affPath] = process.argv.slice(2);
if (!dicPath || !affPath) { console.error('Uso: node tools/letras/build-palabras.js <es-ES.dic> <es-ES.aff>'); process.exit(2); }

const MAX_LEN = 12;
const RULES = new Set(['S', 'G']);

// Reglas de sufijo del .aff: SFX <flag> <quitar> <añadir>[/flags] <condición>
const sfx = {};
for (const line of fs.readFileSync(affPath, 'utf8').split(/\r?\n/)) {
    const m = /^SFX\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!m || !RULES.has(m[1]) || /^[YN]$/.test(m[2])) continue;
    const strip = m[2] === '0' ? '' : m[2];
    const add = m[3].split('/')[0] === '0' ? '' : m[3].split('/')[0];
    (sfx[m[1]] = sfx[m[1]] || []).push({ strip, add, cond: new RegExp(m[4] + '$') });
}

// Normalizada para el juego: minúsculas, sin tildes ni diéresis, la ñ se queda
function norm(w) {
    return w.toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'ñ');
}

// Las entradas sin reglas (sin plural ni nada) incluyen formas sueltas de verbos irregulares
// («dábamos», «éramos», «andándole», «aboliendo»…): fuera las que lo parecen por su terminación
// (pronombre pegado tras una tilde, imperfecto, condicional, subjuntivo, vosotros, gerundio).
// Los adverbios en -mente y las palabras que en otra entrada sí llevan plural o femenino se quedan.
const VERB_LIKE = [
    /[áéíóú][a-zñ]*(se|la|las|lo|los|le|les|me|te|nos|os)$/,
    /(ábamos|abais|íamos|íais|aríamos|eríamos|iríamos|aríais|eríais|iríais|áramos|iéramos|arais|ierais|ásemos|iésemos|aseis|ieseis|áis|éis|ríais)$/,
    /(ando|iendo|yendo)$/,
];
const KEEP = new Set(['cuando']);
function verbLike(w) { return !/mente$/.test(w) && !KEEP.has(w) && VERB_LIKE.some(re => re.test(w)); }

const out = new Map(); // normalizada → forma con tilde (o '' si es igual)
function add(w) {
    if (!/^[a-záéíóúüñ]+$/.test(w)) return; // solo letras (sin guiones, apóstrofos ni mayúsculas)
    const n = norm(w);
    if (n.length < 2 || n.length > MAX_LEN) return;
    if (!out.has(n) || (out.get(n) === '' && w !== n)) out.set(n, w === n ? '' : w);
}

const lines = fs.readFileSync(dicPath, 'utf8').split(/\r?\n/).slice(1);
// Palabras que en alguna entrada llevan plural o femenino: son sustantivos o adjetivos
const inflected = new Set();
for (const line of lines) { const [stem, fl = ''] = line.split('/'); if (/[SG]/.test(fl)) inflected.add(stem); }
let dropped = 0;
for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [stem, flagStr = ''] = line.split('/');
    if (!/^[a-záéíóúüñ]/.test(stem)) continue; // nombres propios y siglas fuera
    if (!flagStr && !inflected.has(stem) && verbLike(stem)) { dropped++; continue; }
    add(stem);
    for (const flag of Array.from(flagStr)) {
        for (const r of (sfx[flag] || [])) {
            if (!r.cond.test(stem) || !stem.endsWith(r.strip)) continue;
            add(stem.slice(0, stem.length - r.strip.length) + r.add);
        }
    }
}

const sorted = [...out.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
const dest = path.join(__dirname, '..', '..', 'data', 'letras', 'palabras.txt');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, sorted.map(([n, w]) => w ? n + '\t' + w : n).join('\n') + '\n');
console.log(`${dropped} formas verbales sueltas quitadas · ${sorted.length} palabras → ${dest} (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
