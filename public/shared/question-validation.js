(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.QuestionValidation = api;
})(typeof self !== 'undefined' ? self : this, function () {

  function nonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function isNumericPresent(v) {
    return v !== null && v !== undefined && v !== '' && !isNaN(Number(v));
  }

  function isComplete(type, content) {
    var c = content || {};
    var missing = [];

    switch (type) {
      case 'multirespuesta': {
        if (!nonEmpty(c.statement)) missing.push('statement');
        var opts = Array.isArray(c.options) ? c.options.filter(function (o) { return nonEmpty(o); }) : [];
        if (opts.length < 2) missing.push('options');
        if (!Array.isArray(c.correct) || c.correct.length < 1) missing.push('correct');
        break;
      }
      case 'pulsador': {
        if (!nonEmpty(c.statement)) missing.push('statement');
        if (!nonEmpty(c.answer)) missing.push('answer');
        break;
      }
      case 'precio': {
        if (!nonEmpty(c.statement)) missing.push('statement');
        if (!isNumericPresent(c.correct_value)) missing.push('correct_value');
        break;
      }
      case 'boom': {
        if (!nonEmpty(c.statement)) missing.push('statement');
        var items = Array.isArray(c.items) ? c.items.filter(function (i) { return nonEmpty(i); }) : [];
        if (items.length < 2) missing.push('items');
        // El orden correcto tiene que nombrar cada elemento una vez (si no, nadie puede acertar)
        var n = Array.isArray(c.items) ? c.items.length : 0;
        var ord = Array.isArray(c.correct_order) ? c.correct_order : [];
        var seen = {};
        var okOrder = ord.length === n && ord.every(function (v) {
          if (typeof v !== 'number' || v % 1 !== 0 || v < 0 || v >= n || seen[v]) return false;
          seen[v] = true; return true;
        });
        if (items.length >= 2 && !okOrder) missing.push('correct_order');
        break;
      }
      case 'ruleta': {
        if (!nonEmpty(c.phrase)) missing.push('phrase');
        break;
      }
      case 'imagen': {
        if (!nonEmpty(c.image)) missing.push('image');
        // La respuesta es opcional (el formulario lo indica así): solo se muestra si existe
        break;
      }
      case 'aclara': {
        if (!nonEmpty(c.image)) missing.push('image');
        if (!nonEmpty(c.answer)) missing.push('answer');
        break;
      }
      case 'imagen_fija': {
        if (!nonEmpty(c.image) && !nonEmpty(c.video)) missing.push('image_or_video');
        break;
      }
      case 'cancion': {
        if (!nonEmpty(c.answer)) missing.push('answer');
        break;
      }
      case 'identidad': {
        if (!nonEmpty(c.statement)) missing.push('statement');
        var pairs = Array.isArray(c.pairs) ? c.pairs : [];
        if (pairs.length < 2) missing.push('pairs');
        var allItemsOk = pairs.length >= 2 && pairs.every(function (p) {
          var l = p.left || {}; var r = p.right || {};
          return (nonEmpty(l.image) || nonEmpty(l.text)) && (nonEmpty(r.image) || nonEmpty(r.text));
        });
        if (pairs.length >= 2 && !allItemsOk) missing.push('pair_items');
        break;
      }
      case 'pictionary': {
        if (!nonEmpty(c.word)) missing.push('word');
        break;
      }
      case 'letras': {
        // De 4 a 12 letras (A-Z y Ñ)
        var ls = Array.isArray(c.letters) ? c.letters : [];
        if (ls.length < 4 || ls.length > 12 || !ls.every(function (x) { return typeof x === 'string' && /^[A-ZÑ]$/.test(x); })) missing.push('letters');
        break;
      }
      case 'cifras': {
        // Objetivo entero positivo y de 2 a 7 números enteros positivos
        var t = Number(c.target);
        if (!(t > 0 && t % 1 === 0 && t <= 100000)) missing.push('target'); // mismos topes que shared/cifras.js
        var ns = Array.isArray(c.numbers) ? c.numbers : [];
        if (ns.length < 2 || ns.length > 7 || !ns.every(function (v) { v = Number(v); return v > 0 && v % 1 === 0 && v <= 10000; })) missing.push('numbers');
        break;
      }
      case 'abierta': {
        // Respuesta abierta: el enunciado general es opcional; cada subpregunta con texto y respuesta
        var subs = Array.isArray(c.subs) ? c.subs : [];
        if (subs.length < 1) missing.push('subs');
        else if (!subs.every(function (s) { return s && nonEmpty(s.text) && nonEmpty(s.answer); })) missing.push('sub_items');
        break;
      }
      case 'karaoke': {
        var VALID_COLORS = ['rojo', 'amarillo', 'azul', 'verde'];
        if (!nonEmpty(c.lyrics)) { missing.push('lyrics'); break; }
        var blocks = c.lyrics.split(/^\s*---\s*$/m).filter(function (b) { return b.trim().length > 0; });
        if (blocks.length < 1) missing.push('lyrics');
        if ([1, 2, 4].indexOf(c.numColors) === -1) missing.push('numColors');
        if (!Array.isArray(c.colors) || c.colors.length !== c.numColors) missing.push('colors');
        else {
          var allValid = c.colors.every(function (col) { return VALID_COLORS.indexOf(col) !== -1; });
          var noDups = c.colors.length === (new Set(c.colors)).size;
          if (!allValid || !noDups) missing.push('colors');
        }
        if (typeof c.basePoints !== 'number' || c.basePoints < 0 || c.basePoints !== Math.floor(c.basePoints)) missing.push('basePoints');
        break;
      }
      default:
        break;
    }

    return { complete: missing.length === 0, missing: missing };
  }

  var LABELS = {
    statement: 'enunciado',
    answer: 'respuesta',
    options: 'opciones (mínimo 2)',
    correct: 'opción correcta marcada',
    correct_value: 'valor / precio',
    items: 'elementos (mínimo 2)',
    phrase: 'frase',
    image: 'imagen',
    image_or_video: 'imagen o vídeo',
    audio: 'audio',
    pairs: 'parejas (mínimo 2)',
    pair_items: 'cada elemento con foto o texto',
    lyrics: 'letra de la canción',
    numColors: 'número de colores (1, 2 o 4)',
    colors: 'colores seleccionados',
    basePoints: 'puntos base (entero ≥ 0)',
    subs: 'subpreguntas (mínimo 1)',
    sub_items: 'cada subpregunta con su texto y su respuesta',
    word: 'palabra a dibujar',
    target: 'número objetivo',
    numbers: 'números (de 2 a 7)',
    letters: 'letras (de 4 a 12)'
  };

  // ── Respuesta abierta: comparar lo que escribe un equipo con las respuestas válidas ──
  // Da igual mayúsculas, tildes (la ñ cuenta como n), signos de puntuación y espacios de más.
  function normAnswer(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }
  // Respuesta principal + otras válidas (una sola celda separada por «/»)
  function acceptedAnswers(sub) {
    sub = sub || {};
    var list = [String(sub.answer || '')];
    String(sub.alts || '').split('/').forEach(function (a) { list.push(a); });
    var seen = {}, out = [];
    list.forEach(function (a) { var n = normAnswer(a); if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
    return out;
  }
  function matchesSub(text, sub) {
    var n = normAnswer(text);
    return !!n && acceptedAnswers(sub).indexOf(n) >= 0;
  }

  // ── Puntos de una prueba ──
  // «points» = lo máximo que da acertar (la mitad fija y la otra mitad según la rapidez, en las
  // pruebas con tiempo); «fastestExtra» = +10 % al más rápido de los que aciertan (por defecto sí).
  // Los juegos anteriores guardaban «basePoints» + «bonusMax»: se convierten al vuelo. En las pruebas
  // donde el bonus no se usaba (pulsador, sin tiempo, imagen que se aclara) solo cuentan los base, y
  // en Respuesta abierta el bonus era el premio al que más acierta, que ahora es el extra.
  var DEFAULT_POINTS = 500;
  var EXTRA_RATIO = 0.1;
  var BASE_ONLY_TYPES = { pulsador: 1, ruleta: 1, imagen: 1, imagen_fija: 1, cancion: 1, aclara: 1, karaoke: 1, abierta: 1 };
  function present(v) { return v !== null && v !== undefined && v !== '' && !isNaN(Number(v)); }
  // Pictionary sin tiempo (tiempo 0 en la ronda y la pregunta sin el suyo) tampoco usaba el bonus
  function usedBonus(type, qc, rc) {
    if (BASE_ONLY_TYPES[type]) return false;
    if (type === 'pictionary') return Number(qc && qc.time) > 0 || !(present(rc && rc.time) && Number(rc.time) === 0);
    return true;
  }
  function legacyTotal(type, qc, rc, base, bonus) {
    return Math.max(0, Math.round(Number(base) || 0) + (usedBonus(type, qc, rc) ? Math.round(Number(bonus) || 0) : 0));
  }
  function roundPoints(type, rc) {
    rc = rc || {};
    if (present(rc.points)) return Math.max(0, Math.round(Number(rc.points)));
    if (present(rc.basePoints) || present(rc.bonusMax)) return legacyTotal(type, {}, rc, present(rc.basePoints) ? rc.basePoints : 100, present(rc.bonusMax) ? rc.bonusMax : 50);
    return DEFAULT_POINTS;
  }
  // Puntos de la pregunta: los suyos si los tiene; si no, los de la ronda
  function questionPoints(type, qc, rc) {
    qc = qc || {}; rc = rc || {};
    if (present(qc.points)) return Math.max(0, Math.round(Number(qc.points)));
    if (present(qc.basePoints) || present(qc.bonusMax)) {
      var rBase = present(rc.basePoints) ? rc.basePoints : 100, rBonus = present(rc.bonusMax) ? rc.bonusMax : 50;
      if (present(rc.points)) { rBase = rc.points; rBonus = 0; }
      return legacyTotal(type, qc, rc, present(qc.basePoints) ? qc.basePoints : rBase, present(qc.bonusMax) ? qc.bonusMax : rBonus);
    }
    return roundPoints(type, rc);
  }
  function fastestExtraOf(qc, rc) {
    qc = qc || {}; rc = rc || {};
    if (typeof qc.fastestExtra === 'boolean') return qc.fastestExtra;
    if (typeof rc.fastestExtra === 'boolean') return rc.fastestExtra;
    return true;
  }
  function extraPoints(points) { return Math.round((Number(points) || 0) * EXTRA_RATIO); }
  // Lo que se lleva quien acierta: con tiempo, la mitad fija y la otra mitad según lo que quedaba
  function speedPoints(points, remaining, total) {
    points = Math.max(0, Math.round(Number(points) || 0));
    if (!(total > 0)) return points;
    var half = Math.floor(points / 2);
    var frac = Math.min(1, Math.max(0, (Number(remaining) || 0) / total));
    return (points - half) + Math.floor(half * frac);
  }

  return { isComplete: isComplete, LABELS: LABELS, normAnswer: normAnswer, acceptedAnswers: acceptedAnswers, matchesSub: matchesSub,
    DEFAULT_POINTS: DEFAULT_POINTS, EXTRA_RATIO: EXTRA_RATIO, roundPoints: roundPoints, questionPoints: questionPoints,
    fastestExtraOf: fastestExtraOf, extraPoints: extraPoints, speedPoints: speedPoints };
});
