// Mini cliente CDP para hacer capturas con Edge sin dependencias (Node 24 trae WebSocket).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function launch(profileDir) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profileDir,
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate', '--lang=es-ES', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return proc; } catch {} await wait(200); }
    throw new Error('Edge no arrancó');
}

class Page {
    constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } else if (d.method) this.events.push(d); };
    }
    send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); }); }
    async size(w, h, mobile = false, dpr = 1) {
        await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile, screenWidth: w, screenHeight: h });
        if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    async go(url, settle = 1500) { await this.send('Page.navigate', { url }); await wait(settle); }
    async eval(expr) {
        const r = await this.send('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result.value;
    }
    async shot(file, quality = 82) {
        const r = await this.send('Page.captureScreenshot', { format: 'webp', quality, captureBeyondViewport: false });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return fs.statSync(file).size;
    }
}

async function newPage() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const t = await r.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    await p.send('Page.enable'); await p.send('Runtime.enable');
    return p;
}

// Página en un contexto propio (como otro dispositivo: su propio localStorage y cookies)
let _browser = null;
async function browserConn() {
    if (_browser) return _browser;
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    _browser = new Page(ws);
    return _browser;
}
async function newIsolatedPage() {
    const b = await browserConn();
    const { browserContextId } = await b.send('Target.createBrowserContext', { disposeOnDetach: false });
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
    await wait(300);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find(x => x.id === targetId);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    await p.send('Page.enable'); await p.send('Runtime.enable');
    return p;
}
async function waitFor(page, expr, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await page.eval('return !!(' + expr + ');')) return true; } catch (e) {} await wait(250); }
    throw new Error('no llegó: ' + expr);
}
async function closeAll() {
    try { const b = await browserConn(); await b.send('Browser.close'); } catch (e) {}
}

module.exports = { launch, newPage, newIsolatedPage, waitFor, closeAll, wait };
