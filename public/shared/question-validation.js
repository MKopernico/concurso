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
    sub_items: 'cada subpregunta con su texto y su respuesta'
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

  return { isComplete: isComplete, LABELS: LABELS, normAnswer: normAnswer, acceptedAnswers: acceptedAnswers, matchesSub: matchesSub };
});
