// Reduce las fotos en el navegador antes de subirlas (el servidor no tiene librerías de imagen
// nativas: ni Render ni el kit offline las necesitan). Lado mayor ≤ 1920 px sin agrandar nunca;
// sin transparencia → JPEG 0,85; con transparencia (logos) → PNG solo redimensionado, o WebP con
// transparencia si el PNG sigue pesando más de 1 MB (y el navegador sabe hacerlo). Se queda el
// original si es SVG, GIF animado, no es imagen, el navegador no la sabe abrir o el resultado no
// pesa claramente menos. La orientación EXIF de las fotos de móvil la aplica el navegador al
// dibujar la <img> (Chrome 81+, Safari 13.1+, Firefox 77+) y el JPEG nuevo ya sale derecho.
// Uso: const r = await ImageShrink.shrink(file); form.append('file', r.file); r.note → aviso.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ImageShrink = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var MAX_SIDE = 1920;
  var QUALITY = 0.85;
  var SKIP_BYTES = 200 * 1024;   // sin redimensionar, por debajo de esto no merece la pena tocarla
  var MIN_GAIN = 0.9;            // sin redimensionar, solo si queda en el 90 % o menos
  var PNG_OK_BYTES = 1024 * 1024; // con transparencia, un PNG de más de esto se intenta en WebP
  var EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

  // GIF animado = más de un fotograma (cada uno empieza por un bloque de control gráfico 21 F9 04)
  function isAnimatedGif(bytes) {
    var frames = 0;
    for (var i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9 && bytes[i + 2] === 0x04) {
        // tras los 4 bytes de datos y el terminador 00 viene el descriptor de imagen (2C)
        if (bytes[i + 8] === 0x2C || bytes[i + 8] === 0x21) { frames++; if (frames > 1) return true; }
      }
    }
    return false;
  }

  // Tamaño final: lado mayor ≤ max, nunca más grande que el original
  function targetSize(w, h, max) {
    max = max || MAX_SIDE;
    var scale = Math.min(1, max / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), resize: scale < 1 };
  }

  // ¿Nos quedamos con el resultado? Más pesado que el original nunca; sin redimensionar, solo si
  // ahorra al menos un 10 % (volver a comprimir un JPEG ya ligero solo pierde calidad).
  function worthIt(origBytes, newBytes, resized) {
    if (!(newBytes > 0) || newBytes >= origBytes) return false;
    return resized || newBytes <= origBytes * MIN_GAIN;
  }

  // 2,7 MB / 380 KB
  function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function noteOf(before, after) {
    return 'Foto reducida: ' + formatBytes(before) + ' → ' + formatBytes(after);
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('no se pudo abrir la imagen')); };
      img.src = url;
    });
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Reducir a mitades hasta acercarse y el último paso al tamaño exacto: un salto grande de una
  // vez (4000 → 1000) deja dientes de sierra. No se crea nunca un lienzo del tamaño original
  // (en iPad el lienzo tiene un límite de memoria).
  function drawScaled(img, w, h) {
    var src = img, sw = img.naturalWidth, sh = img.naturalHeight;
    while (sw / 2 >= w * 1.5) {
      var hw = Math.round(sw / 2), hh = Math.round(sh / 2);
      var step = makeCanvas(hw, hh), sctx = step.getContext('2d');
      sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, 0, 0, hw, hh);
      src = step; sw = hw; sh = hh;
    }
    var out = makeCanvas(w, h), ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return out;
  }

  function hasAlpha(canvas) {
    var data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (var i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  }

  // null si el navegador no sabe codificar ese tipo (Safari devuelve un PNG cuando se le pide WebP)
  function encode(canvas, type) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b && b.type === type ? b : null); }, type, QUALITY);
    });
  }

  function baseName(name) {
    return String(name || 'foto').replace(/\.[^.\/\\]*$/, '') || 'foto';
  }

  // → { file, reduced, before, after, width, height, note, reason }. Nunca falla: ante cualquier
  // problema devuelve el archivo original tal cual.
  async function shrink(file, opts) {
    opts = opts || {};
    var keep = function (reason) { return { file: file, reduced: false, before: file && file.size, after: file && file.size, note: '', reason: reason }; };
    if (!file || !/^image\//.test(file.type || '')) return keep('no es imagen');
    if (file.type === 'image/svg+xml') return keep('svg');
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return keep('sin navegador');
    try {
      if (file.type === 'image/gif' && isAnimatedGif(new Uint8Array(await file.arrayBuffer()))) return keep('gif animado');
      var img = await loadImage(file);
      if (!img.naturalWidth || !img.naturalHeight) return keep('sin tamaño');
      var t = targetSize(img.naturalWidth, img.naturalHeight, opts.maxSide);
      if (!t.resize && file.size <= SKIP_BYTES) return keep('ya es ligera');
      var canvas = drawScaled(img, t.width, t.height);
      var alpha = file.type !== 'image/jpeg' && hasAlpha(canvas);
      var blob = await encode(canvas, alpha ? 'image/png' : 'image/jpeg');
      // Con transparencia, PNG si queda bien; si no (recortes con mucho detalle: el PNG del
      // navegador puede pesar más que el original), WebP con transparencia, que pesa ~6 veces menos
      if (alpha && !(blob && worthIt(file.size, blob.size, t.resize) && blob.size <= PNG_OK_BYTES)) {
        var webp = await encode(canvas, 'image/webp');
        if (webp && (!blob || webp.size < blob.size)) blob = webp;
      }
      canvas.width = canvas.height = 0; // libera memoria cuanto antes (iPad)
      if (!blob) return keep('el navegador no sabe codificarla');
      if (!worthIt(file.size, blob.size, t.resize)) return keep('no pesa menos');
      var out = new File([blob], baseName(file.name) + EXT[blob.type], { type: blob.type, lastModified: Date.now() });
      return { file: out, reduced: true, before: file.size, after: out.size, width: t.width, height: t.height, alpha: alpha, note: noteOf(file.size, out.size), reason: '' };
    } catch (e) {
      return keep('error: ' + (e && e.message || e));
    }
  }

  return {
    MAX_SIDE: MAX_SIDE, QUALITY: QUALITY,
    isAnimatedGif: isAnimatedGif, targetSize: targetSize, worthIt: worthIt, formatBytes: formatBytes,
    shrink: shrink,
  };
});
