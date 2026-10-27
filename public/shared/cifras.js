// Cifras: cuentas con unos números para acercarse a un objetivo (como en el programa de la tele).
// Compartido por servidor, backoffice, iPads, coordinador y pantalla.
//
// Reglas: + − × ÷ entre dos números; solo resultados enteros y positivos (la resta, si sale mayor
// que cero; la división, si es exacta). Cada número se usa una vez, y cada resultado pasa a ser un
// número más. Vale cualquier número al que se llegue (también uno de los de partida), salvo con
// «usar todas», que obliga a gastar todos los de partida.
//
// Las cuentas de un equipo son pasos [a, op, b] con a y b índices de «fichas»: primero las de
// partida (0..n-1) y después, una por paso, la que da cada resultado (n, n+1…).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Cifras = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var OPS = ['+', '-', '*', '/'];
  var SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };
  var MAX_VALUE = 10000000;

  function apply(a, op, b) {
    var r;
    if (op === '+') r = a + b;
    else if (op === '-') r = a - b;
    else if (op === '*') r = a * b;
    else if (op === '/') r = (b !== 0 && a % b === 0) ? a / b : null;
    else return null;
    return (r !== null && r > 0 && r <= MAX_VALUE && r % 1 === 0) ? r : null;
  }
  // Por qué no vale una cuenta (para el iPad)
  function whyNot(a, op, b) {
    if (op === '-' && a <= b) return 'La resta tiene que dar más de cero';
    if (op === '/' && (b === 0 || a % b !== 0)) return 'La división tiene que ser exacta';
    if (op === '*' && a * b > MAX_VALUE) return 'Número demasiado grande';
    return 'Esa cuenta no vale';
  }
  function fmtStep(s) { return s.a + ' ' + SYMBOL[s.op] + ' ' + s.b + ' = ' + s.r; }

  // Números de partida válidos: 2 a 7 enteros positivos
  function cleanNumbers(arr) {
    if (!Array.isArray(arr)) return null;
    var out = arr.map(function (v) { return Number(v); });
    if (out.length < 2 || out.length > 7 || !out.every(function (v) { return v > 0 && v % 1 === 0 && v <= 10000; })) return null;
    return out;
  }
  function validTarget(t) { t = Number(t); return t > 0 && t % 1 === 0 && t <= 100000 ? t : null; }

  // Repasa las cuentas de un equipo. Se queda con los pasos válidos (al primero que no vale, para).
  //  → { steps: [{a,op,b,r, ia, ib}], values, best: {value, dist, tile} | null, path: [pasos que llevan a best], error }
  function evaluate(numbers, rawSteps, target, useAll) {
    var nums = cleanNumbers(numbers) || [];
    var n = nums.length;
    var values = nums.slice();
    var deps = nums.map(function (_, i) { return 1 << i; });
    var from = nums.map(function () { return -1; }); // paso que creó cada ficha
    var used = nums.map(function () { return false; });
    var steps = [], error = null;
    var list = Array.isArray(rawSteps) ? rawSteps.slice(0, 12) : [];
    for (var k = 0; k < list.length; k++) {
      var s = list[k];
      var ia = Array.isArray(s) ? s[0] : s && s.ia, op = Array.isArray(s) ? s[1] : s && s.op, ib = Array.isArray(s) ? s[2] : s && s.ib;
      ia = Number(ia); ib = Number(ib);
      if (!(ia % 1 === 0 && ib % 1 === 0 && ia >= 0 && ib >= 0 && ia < values.length && ib < values.length && ia !== ib) || used[ia] || used[ib] || OPS.indexOf(op) < 0) { error = 'paso no válido'; break; }
      var r = apply(values[ia], op, values[ib]);
      if (r === null) { error = whyNot(values[ia], op, values[ib]); break; }
      used[ia] = used[ib] = true;
      steps.push({ a: values[ia], op: op, b: values[ib], r: r, ia: ia, ib: ib });
      values.push(r); deps.push(deps[ia] | deps[ib]); from.push(steps.length - 1); used.push(false);
    }
    var all = (1 << n) - 1;
    var best = null;
    var t = validTarget(target);
    if (t) {
      for (var i = 0; i < values.length; i++) {
        if (useAll && deps[i] !== all) continue;
        var d = Math.abs(values[i] - t);
        // Empate: el que necesita menos cuentas
        if (!best || d < best.dist || (d === best.dist && popcount(deps[i]) < popcount(deps[best.tile]))) best = { value: values[i], dist: d, tile: i };
      }
    }
    return { steps: steps, values: values, best: best, path: best ? pathTo(best.tile, n, from, steps) : [], error: error };
  }
  function popcount(x) { var c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
  // Pasos (en orden) que hacen falta para llegar a una ficha
  function pathTo(tile, n, from, steps) {
    var need = {}, stack = [tile];
    while (stack.length) {
      var t = stack.pop();
      if (t < n || need[t]) continue;
      need[t] = true;
      var s = steps[from[t]];
      stack.push(s.ia, s.ib);
    }
    return steps.filter(function (s, i) { return need[n + i]; }).map(function (s) { return { a: s.a, op: s.op, b: s.b, r: s.r }; });
  }

  // La mejor solución: la más cercana y, a igual distancia, con menos cuentas.
  //  → { value, dist, steps: [{a,op,b,r}] }
  function solve(numbers, target, useAll, maxNodes) {
    var nums = cleanNumbers(numbers);
    var t = validTarget(target);
    if (!nums || !t) return null;
    var limit = maxNodes || 4000000, nodes = 0;
    var best = { dist: Infinity, value: null, steps: null };
    function consider(v, steps, left) {
      if (useAll && left > 0) return;
      var d = Math.abs(v - t);
      if (d < best.dist || (d === best.dist && steps.length < best.steps.length)) best = { dist: d, value: v, steps: steps.slice() };
    }
    if (!useAll || nums.length === 1) nums.forEach(function (v) { consider(v, [], 0); });
    var path = [];
    function dfs(list) {
      if (++nodes > limit) return;
      if (best.dist === 0 && path.length + 1 >= best.steps.length) return; // ya hay una exacta igual de corta
      var len = list.length;
      var seen = {};
      for (var i = 0; i < len; i++) for (var j = i + 1; j < len; j++) {
        var x = list[i] >= list[j] ? list[i] : list[j], y = list[i] >= list[j] ? list[j] : list[i];
        var key = x + ',' + y;
        if (seen[key]) continue;
        seen[key] = 1;
        var rest = [];
        for (var k = 0; k < len; k++) if (k !== i && k !== j) rest.push(list[k]);
        for (var o = 0; o < 4; o++) {
          var op = OPS[o];
          if ((op === '*' || op === '/') && y === 1) continue; // ×1 y ÷1 no aportan nada
          var r = apply(x, op, y);
          if (r === null || (op === '-' && r === y) || (op === '/' && r === y)) continue; // repetidas: a−b=b, a÷b=b
          path.push({ a: x, op: op, b: y, r: r });
          consider(r, path, rest.length);
          if (rest.length) { rest.push(r); dfs(rest); rest.pop(); }
          path.pop();
          if (nodes > limit) return;
        }
      }
    }
    dfs(nums);
    return best.steps ? { value: best.value, dist: best.dist, steps: best.steps } : null;
  }

  // ── Generador por niveles ──
  // facil: 4 números pequeños, objetivo de 2 cifras. medio: 5 números (uno grande), objetivo
  // 100-500. dificil: como en la tele, 6 números (1-10 y uno o dos de 25/50/75/100), 101-999.
  // Siempre con solución exacta y nunca de un paso.
  var LEVELS = {
    facil:   { count: 4, bigs: [0, 0], small: 10, min: 10,  max: 99,  minSteps: 2 },
    medio:   { count: 5, bigs: [1, 1], small: 10, min: 100, max: 500, minSteps: 2 },
    dificil: { count: 6, bigs: [1, 2], small: 10, min: 101, max: 999, minSteps: 3 },
  };
  var LEVEL_NAMES = { facil: 'Fácil', medio: 'Medio', dificil: 'Difícil' };
  var BIGS = [25, 50, 75, 100];

  function generate(level, rnd) {
    var L = LEVELS[level] || LEVELS.medio;
    rnd = rnd || Math.random;
    var pick = function (n) { return Math.floor(rnd() * n); };
    for (var tries = 0; tries < 300; tries++) {
      var nb = L.bigs[0] + pick(L.bigs[1] - L.bigs[0] + 1);
      var bigs = BIGS.slice(), numbers = [];
      for (var b = 0; b < nb; b++) numbers.push(bigs.splice(pick(bigs.length), 1)[0]);
      var counts = {};
      while (numbers.length < L.count) {
        var v = 1 + pick(L.small);
        if ((counts[v] || 0) >= 2) continue; // como en la tele: cada número sale como mucho dos veces
        counts[v] = (counts[v] || 0) + 1;
        numbers.push(v);
      }
      var target = L.min + pick(L.max - L.min + 1);
      if (numbers.indexOf(target) >= 0) continue;
      var sol = solve(numbers, target, false, 1500000);
      if (!sol || sol.dist !== 0 || sol.steps.length < L.minSteps) continue;
      numbers.sort(function (x, y) { return x - y; });
      return { numbers: numbers, target: target, solution: sol.steps };
    }
    return null;
  }

  return { OPS: OPS, SYMBOL: SYMBOL, apply: apply, whyNot: whyNot, fmtStep: fmtStep, cleanNumbers: cleanNumbers, validTarget: validTarget,
    evaluate: evaluate, solve: solve, generate: generate, LEVELS: LEVELS, LEVEL_NAMES: LEVEL_NAMES };
});
