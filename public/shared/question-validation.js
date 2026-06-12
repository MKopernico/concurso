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
        break;
      }
      case 'ruleta': {
        if (!nonEmpty(c.phrase)) missing.push('phrase');
        break;
      }
      case 'imagen': {
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
    audio: 'audio'
  };

  return { isComplete: isComplete, LABELS: LABELS };
});
