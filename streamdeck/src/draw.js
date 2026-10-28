// Dibujo de las teclas (SVG 144×144 → data URI) e iconos sencillos de trazo (24×24).
// El texto va dentro de la imagen: así se ve igual en todos los Stream Deck.

const ICONS = {
    next: '<circle cx="12" cy="12" r="9"/><path d="M9 8l4 4-4 4M13 8l4 4-4 4"/>',
    chevL: '<path d="M15 5l-7 7 7 7"/>',
    chevR: '<path d="M9 5l7 7-7 7"/>',
    clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M10 2h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21h4"/>',
    hand: '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.6-1.5L8 14"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    home: '<path d="M4 11l8-7 8 7M6 9v11h12V9"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
    skipF: '<path d="M5 5l10 7-10 7zM19 5v14"/>',
    skipB: '<path d="M19 5L9 12l10 7zM5 5v14"/>',
    grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    stop: '<path d="M6 6h12v12H6z"/>',
    mute: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6"/>',
    vol: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    volDown: '<path d="M4 9h4l5-4v14l-5-4H4zM16 12h5"/>',
    volUp: '<path d="M4 9h4l5-4v14l-5-4H4zM16 12h5M18.5 9.5v5"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
    spotify: '<circle cx="12" cy="12" r="9"/><path d="M7.5 9.5c3-1 6.5-.7 9 .8M8 12.6c2.5-.7 5-.5 7.2.7M8.6 15.4c2-.5 3.8-.3 5.4.5"/>',
    star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
    gift: '<path d="M4 10h16v4H4zM6 14v7h12v-7M12 10v11M12 10c-2-3-6-3-5 0M12 10c2-3 6-3 5 0"/>',
    link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
    off: '<path d="M3 3l18 18M8.5 8.6A6 6 0 0 0 7 12M5 5.2A10 10 0 0 0 2 12M12 18h.01M15.5 15.5a5 5 0 0 0-7 0"/>',
    dice: '<path d="M5 5h14v14H5z"/><circle cx="9" cy="9" r=".8"/><circle cx="15" cy="15" r=".8"/><circle cx="15" cy="9" r=".8"/><circle cx="9" cy="15" r=".8"/>',
};

const COLORS = {
    base: '#1b1d2a', on: '#15803d', warn: '#a16207', bad: '#b91c1c', accent: '#0e7490', off: '#2a2c38', blue: '#1d4ed8', purple: '#6d28d9',
};

const escXml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Corta un texto en dos líneas como mucho para que quepa (aprox. por número de letras)
function lines(text, max) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const out = [];
    let cur = '';
    for (const w of words) {
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
        else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    if (out.length > 2) { out.length = 2; out[1] = out[1].slice(0, max - 1) + '…'; }
    return out.map(l => l.length > max ? l.slice(0, max - 1) + '…' : l);
}

// Tecla: icono arriba, texto grande (big) y una línea pequeña (small). tone = clave de COLORS.
function key(o) {
    const bg = COLORS[o.tone] || COLORS.base;
    const fg = o.tone === 'off' ? '#7c7f93' : '#ffffff';
    const parts = [`<rect width="144" height="144" rx="18" fill="${bg}"/>`];
    const hasIcon = o.icon && ICONS[o.icon];
    const big = o.big != null ? String(o.big) : '';
    const bigLines = big ? lines(big, big.length <= 6 ? 6 : 11) : [];
    // Con icono, el texto no pasa de 30 (si no, «QR» o «Home» se comen el icono)
    let bigSize = !big ? 0 : big.length <= 3 ? 46 : big.length <= 6 ? 34 : bigLines.length > 1 ? 20 : 22;
    if (hasIcon) bigSize = !big ? 0 : big.length <= 5 ? 30 : big.length <= 8 ? 24 : bigLines.length > 1 ? 20 : 22;
    if (hasIcon) {
        const s = bigLines.length ? 46 : 70;
        const x = (144 - s) / 2, y = bigLines.length ? 12 : (o.small ? 22 : 37);
        parts.push(`<g transform="translate(${x} ${y}) scale(${s / 24})" fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[o.icon]}</g>`);
    }
    let y = hasIcon ? 84 : (bigLines.length > 1 ? 58 : 76);
    bigLines.forEach((l, i) => {
        parts.push(`<text x="72" y="${y + i * (bigSize + 4)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${bigSize}" fill="${fg}">${escXml(l)}</text>`);
    });
    if (o.small) {
        const sl = lines(o.small, 15);
        sl.forEach((l, i) => parts.push(`<text x="72" y="${(sl.length > 1 ? 118 : 128) + i * 17}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="${fg}" opacity=".85">${escXml(l)}</text>`));
    }
    if (o.bar != null) {
        const w = Math.max(0, Math.min(1, o.bar)) * 116;
        parts.push(`<rect x="14" y="134" width="116" height="5" rx="2.5" fill="#ffffff" opacity=".18"/><rect x="14" y="134" width="${w.toFixed(1)}" height="5" rx="2.5" fill="#ffffff"/>`);
    }
    return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${parts.join('')}</svg>`);
}

// Icono para la franja táctil del Stream Deck + (48×48, sin fondo)
function dialIcon(icon, color) {
    const p = ICONS[icon] || ICONS.music;
    return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${color || '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`);
}

function svgUri(svg) { return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'); }

// Icono blanco de la lista de acciones del programa Stream Deck (archivo SVG)
function actionIconSvg(icon) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.music}</svg>`;
}

module.exports = { key, dialIcon, actionIconSvg, ICONS, COLORS };
