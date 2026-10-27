// Letras: formar la palabra más larga con unas letras (como en el programa de la tele).
// Compartido por servidor, backoffice, iPads, coordinador y pantalla. El diccionario no está aquí:
// solo lo tiene el servidor (letras-dict.js).
//
// Las letras van en mayúscula y sin tilde (la Ñ es una letra más). Una palabra del juego se guarda
// «normalizada»: minúsculas, sin tildes ni diéresis, con la ñ. Lo que manda un iPad son los índices
// de las letras usadas, en orden: cada letra se usa una vez.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Letras = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var ALPHABET = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
  var VOWELS = 'AEIOU';

  // Palabra para comparar: minúsculas, sin tildes ni diéresis, la ñ se queda
  function normWord(w) {
    return String(w == null ? '' : w).toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'ñ').replace(/[^a-zñ]/g, '');
  }
  // Letras válidas de una celda o un campo: «A E R T», «AERT», «a,e,r,t»… → ['A','E','R','T']
  function cleanLetters(v) {
    var s = Array.isArray(v) ? v.join('') : String(v == null ? '' : v);
    var out = [];
    normWord(s).split('').forEach(function (ch) { out.push(ch === 'ñ' ? 'Ñ' : ch.toUpperCase()); });
    return out;
  }
  function validLetters(arr) { return Array.isArray(arr) && arr.length >= 4 && arr.length <= 12 && arr.every(function (c) { return ALPHABET.indexOf(c) >= 0 && c.length === 1; }); }

  // Palabra que forman unos índices (cada letra una vez): → 'casa' o null si los índices no valen
  function wordFrom(letters, idxs) {
    if (!Array.isArray(letters) || !Array.isArray(idxs) || idxs.length > letters.length) return null;
    var seen = {}, w = '';
    for (var i = 0; i < idxs.length; i++) {
      var k = Number(idxs[i]);
      if (!(k % 1 === 0 && k >= 0 && k < letters.length) || seen[k]) return null;
      seen[k] = 1;
      w += letters[k] === 'Ñ' ? 'ñ' : String(letters[k]).toLowerCase();
    }
    return w;
  }
  // ¿Se puede formar esta palabra (normalizada) con estas letras?
  function canForm(word, letters) {
    var counts = {};
    letters.forEach(function (c) { var k = c === 'Ñ' ? 'ñ' : c.toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    for (var i = 0; i < word.length; i++) { if (!counts[word[i]]) return false; counts[word[i]]--; }
    return true;
  }
  function upper(w) { return String(w || '').toUpperCase(); }

  return { ALPHABET: ALPHABET, VOWELS: VOWELS, normWord: normWord, cleanLetters: cleanLetters, validLetters: validLetters,
    wordFrom: wordFrom, canForm: canForm, upper: upper };
});
