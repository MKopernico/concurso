// Versiones del complemento («1.0.1.0»): ¿a es más nueva que b?
function newer(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
}
// «1.0.1.0» → «1.0.1» (lo que se enseña)
const short = (v) => String(v || '').replace(/(\.0)+$/, '') || '—';

module.exports = { newer, short };
