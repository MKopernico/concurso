// Capturas del manual. Requiere shot-server.js en marcha (puerto 3101).
// Uso: node shots.js [parte]   parte = kit | admin | juego | aclara | todo (por defecto todo)
const { launch, newPage, newIsolatedPage, waitFor, closeAll, wait } = require('./cdp');
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'public/manual/img');
const B = 'http://localhost:3101';
const PW = 'capturas-manual-local';
const GAME = 'g_1b469686';      // Batidora genérica
const ACLARA = 'g_8f91f28c';
const only = process.argv[2] || 'todo';
fs.mkdirSync(OUT, { recursive: true });

async function shot(p, name, clip) { const n = await p.shot(path.join(OUT, name + '.webp'), 82, clip); console.log('  ' + name + '.webp ' + Math.round(n / 1024) + ' KB'); }
// Recorte alrededor de un elemento (con margen), para que una ventana pequeña se lea en el manual
async function around(p, selector, pad = 24) {
    return p.eval(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} };`);
}
async function login(p) { await p.go(B + '/login/', 800); await p.eval(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'${PW}'})}); return 1;`); }
async function nodeCookie() { const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) }); return r.headers.get('set-cookie').split(';')[0]; }
async function skipPreload(p) { await p.eval(`const b=[...document.querySelectorAll('button')].find(x=>/Continuar igualmente|Continuar/.test(x.textContent)&&x.offsetParent); if(b) b.click(); return 1;`); }

async function excelConIncompletas(cookie) {
    const XLSX = require(path.join(REPO, 'node_modules/xlsx'));
    const buf = Buffer.from(await (await fetch(B + '/api/templates/importacion?ejemplo=1', { headers: { cookie } })).arrayBuffer());
    const wb = XLSX.read(buf);
    const add = (sheet, row) => { const ws = wb.Sheets[sheet]; XLSX.utils.sheet_add_aoa(ws, [row], { origin: -1 }); };
    add('Multirespuesta', ['Ejemplo · Multirespuesta', '¿Cuántos continentes hay?', 'Cinco', '', '', '', '', '', '', 20, 100, 50, 0]);
    add('Precio Justo', ['Ejemplo · Precio justo', '¿Cuánto pesa un balón de fútbol (gramos)?', '', '', 20, 100]);
    const file = path.join(require('os').tmpdir(), 'gameshow-ejemplo-con-incompletas.xlsx');
    XLSX.writeFile(wb, file);
    return file;
}

async function partAdmin() {
    console.log('Backoffice');
    const p = await newPage(); await p.size(1366, 768); await login(p);
    await p.go(B + '/admin/', 2000);
    await shot(p, '01-backoffice-lista-juegos');
    // Editar juego (formulario)
    await p.eval(`const g = await api('/games/${GAME}'); openGameModal(g); return 1;`); await wait(700);
    await shot(p, '02-crear-juego');
    await p.eval(`closeModal('modal-game-overlay'); return 1;`).catch(() => {});
    await p.eval(`document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active')); return 1;`);
    // Juego con sus rondas
    await p.eval(`await loadGame('${GAME}'); return 1;`); await wait(800);
    await shot(p, '03-juego-rondas');
    // Formulario de una prueba (multirespuesta) y su puntuación
    await p.eval(`await loadRound('r_830eb307'); return 1;`); await wait(800);
    await p.eval(`openQuestionModal(currentRound.questions[0]); return 1;`); await wait(800);
    await shot(p, '04-formulario-prueba');
    await p.eval(`document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active')); await loadRound('r_4c1eb110'); openQuestionModal(currentRound.questions[1]); return 1;`); await wait(800);
    await p.eval(`const all=[...document.querySelectorAll('.modal-overlay.active label, .modal-overlay.active h3, .modal-overlay.active legend, .modal-overlay.active div')]; const el = all.find(e=>/Bonus especial|Premio|bono/i.test(e.textContent) && e.children.length < 4); if (el) el.scrollIntoView({block:'center'}); return !!el;`); await wait(500);
    await shot(p, '09-puntuacion-bonus');
    await p.eval(`document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active')); return 1;`);
    // Juego nuevo + importar Excel con dos preguntas a medias
    const cookie = await nodeCookie();
    const file = await excelConIncompletas(cookie);
    const gid = await p.eval(`const g = await api('/games', {method:'POST', body:{name:'Fin de curso 2026', date:'2026-06-19', access_code:'2026', note:'Excursión de 6.º · ejemplo importado desde Excel'}}); return g.id;`);
    await p.eval(`await loadGame('${gid}'); openImportModal(); return 1;`); await wait(700);
    await shot(p, '05-importar-excel');
    const doc = await p.send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#excel-file' });
    await p.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
    await p.eval(`await doImportExcel(); return 1;`); await wait(1500);
    await shot(p, '06-resultado-importacion');
    await p.eval(`document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active')); await loadGame('${gid}'); return 1;`); await wait(800);
    await p.eval(`const r = currentGame.rounds.find(r=>r.type==='multirespuesta'); await loadRound(r.id); return 1;`); await wait(800);
    await shot(p, '07-pruebas-incompleta');
    await p.eval(`await loadGame('${gid}'); await publishGame(); return 1;`); await wait(1000);
    await shot(p, '08-bloqueo-publicacion');
}

async function partJuego() {
    console.log('Partida');
    const cookie = await nodeCookie();
    await fetch(B + '/api/games/' + GAME + '/session', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    const pass = (await (await fetch(B + `/api/games/${GAME}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '1234' }) })).json()).pass;
    // Coordinador
    const d = await newPage(); await d.size(1366, 768); await login(d);
    await d.go(B + '/director/' + GAME, 3500); await skipPreload(d); await wait(800);
    // Pantalla de sala
    const s = await newPage(); await s.size(1366, 768);
    await s.go(B + '/screen/' + GAME, 3500); await skipPreload(s);
    // Cuatro iPads, cada uno en su propio «dispositivo»
    const names = ['Rojos', 'Azules', 'Verdes', 'Amarillos'];
    const P = [];
    for (let i = 0; i < names.length; i++) {
        const p = await newIsolatedPage(); await p.size(1024, 768, true);
        await p.go(B + `/play/?g=${GAME}&p=${encodeURIComponent(pass)}`, 3000); await skipPreload(p);
        await waitFor(p, `document.getElementById('teamNameInput') && document.getElementById('teamNameInput').offsetParent`);
        if (i === 0) { await p.eval(`document.getElementById('teamNameInput').value = 'Rojos'; return 1;`); await shot(p, '17-play-crear-equipo'); }
        await p.eval(`document.getElementById('teamNameInput').value = '${names[i]}'; registerTeam(); return 1;`);
        await waitFor(p, `S.myTeamId`);
        P.push(p);
    }
    await wait(1200);
    // Puntos para que el marcador tenga vida
    await d.eval(`const pts={Rojos:340,Azules:410,Verdes:260,Amarillos:180}; S.equipos.forEach(e=>{ if(pts[e.nombre]) emit('director:add_points',{teamId:e.id, points:pts[e.nombre]}); }); return 1;`);
    await wait(600);
    // Menú Home
    await d.eval(`emit('director:show_home'); return 1;`); await wait(1500);
    await shot(d, '10-director-panel');
    await shot(s, '18-screen-menu');
    await shot(P[0], '19-play-menu');
    // QR en la sala
    await d.eval(`emit('director:toggle_qr'); return 1;`); await wait(1200);
    await shot(s, '20-qr-sala');
    await d.eval(`emit('director:toggle_qr'); return 1;`); await wait(600);

    const launch = async (roundName) => {
        await d.eval(`const el=[...document.querySelectorAll('#roundsList .round-item')].find(x=>x.querySelector('.round-name').textContent.replace(/^\\d+\\.\\s*/,'').trim()===${JSON.stringify(roundName)}); el.click(); await new Promise(r=>setTimeout(r,800)); const b=[...document.querySelectorAll('button')].find(x=>/Empezar ronda/.test(x.textContent)&&x.offsetParent); if(b) b.click(); return 1;`);
        await wait(1500);
    };
    // Multirespuesta: la pregunta 1 lleva bono de puntos (su anuncio sale solo en la sala); la 2, de congelar
    await launch('50x15 — Ronda 1');
    await d.eval(`if (!S.director.premioAnuncioVisible) emit('director:toggle_premio_anuncio'); return 1;`); await wait(1800);
    await shot(s, '21-screen-anuncio-premio');
    await d.eval(`if (S.director.premioAnuncioVisible) emit('director:toggle_premio_anuncio'); emit('director:next_question',{at:S.director.currentQuestionIdx, round:S.director.currentRoundId}); return 1;`); await wait(1500);
    await d.eval(`if (S.director.premioAnuncioVisible) emit('director:toggle_premio_anuncio'); return 1;`); await wait(800);
    console.log('  pregunta', await d.eval(`return S.director.currentQuestionIdx + ' ' + JSON.stringify(S.director.questions[S.director.currentQuestionIdx].config.premio);`));
    await d.eval(`emit('director:reveal_options'); return 1;`); await wait(5500);
    // Responden tres equipos; los Rojos aciertan
    const corr = await d.eval(`const q=S.director.questions[S.director.currentQuestionIdx]; const c=q.content.correct; return Array.isArray(c)?c[0]:c;`);
    const pick = [corr, (corr + 1) % 3, corr, (corr + 2) % 3];
    await P[0].eval(`toggleOption(${pick[0]}); return 1;`); await wait(300);
    await shot(P[0], '22-play-multirespuesta');
    await shot(s, '23-screen-pregunta');
    await shot(d, '11-director-pregunta');
    for (let i = 0; i < 3; i++) await P[i].eval(`if(!S.selectedOptions.length) toggleOption(${pick[i]}); submitMulti(); return 1;`);
    await wait(800);
    await d.eval(`emit('director:reveal_answer'); return 1;`); await wait(1800);
    await shot(P[0], '24-play-resultado');
    await shot(d, '37-director-resultados');
    // «Siguiente» en una pregunta con bono abre la ventana del ganador
    await d.eval(`handleNextQuestion(); return 1;`); await wait(1000);
    await shot(d, '12-director-ganador-bono');
    await d.eval(`pgSelectTeam(S.equipos.find(e=>e.nombre==='Rojos').id); confirmPremioGanador(); return 1;`); await wait(1500);
    await shot(s, '36-screen-ganador-bono');
    // Los Rojos usan su bono: congelan a los Azules
    await d.eval(`if (S.director.premioGanadorVisible) emit('director:toggle_premio_ganador'); return 1;`).catch(() => {});
    await wait(800);
    await d.eval(`if (S.director.premioAnuncioVisible) emit('director:toggle_premio_anuncio'); return 1;`).catch(() => {});
    await wait(1200);
    await waitFor(P[0], `document.querySelector('#bonusPanel .bonus-chip')`, 8000).catch(() => console.log('  (sin chip de bono)'));
    await P[0].eval(`openFreezeSelector(); return 1;`); await wait(600);
    await shot(P[0], '25-play-usar-bono');
    await P[0].eval(`const b=[...document.querySelectorAll('.bonus-rival-btn')].find(x=>/Azules/.test(x.textContent)); if(b) b.click(); return 1;`); await wait(700);
    await shot(s, '26-screen-aviso-congelado');
    await wait(500);
    await shot(P[1], '27-play-congelado');
    await d.eval(`emit('director:unblock_all'); return 1;`).catch(() => {});
    // Registro y marcador
    await d.eval(`toggleBonoLog(document.getElementById('btnBonoLog')); return 1;`); await wait(900);
    await shot(d, '15-director-registro');
    await d.eval(`toggleBonoLog(document.getElementById('btnBonoLog')); toggleSection('bottomBar'); return 1;`); await wait(900);
    await shot(d, '16-director-marcador');
    await d.eval(`toggleSection('bottomBar'); return 1;`); await wait(500);
    await d.eval(`toggleScoreboard(); return 1;`); await wait(1800);
    await shot(s, '28-screen-marcador');
    await d.eval(`toggleScoreboard(); return 1;`); await wait(800);
    // Pulsador con cola
    await launch('Prueba pulsador rápido');
    await d.eval(`emit('director:open_buzzer'); return 1;`); await wait(600);
    for (const i of [2, 0, 3]) { await P[i].eval(`doBuzz(); return 1;`); await wait(250); }
    await wait(900);
    await shot(d, '13-director-pulsador');
    await shot(P[2], '29-play-pulsador');
    await shot(s, '30-screen-pulsador');
    // Boom con huecos (un iPad a medio colocar)
    await launch('Boom — Ronda 1');
    await d.eval(`emit('director:reveal_options'); return 1;`); await wait(5500);
    await P[3].eval(`hzPlace(HZ.pool[0], 0); await new Promise(r=>setTimeout(r,200)); hzPlace(HZ.pool[0], 2); return 1;`); await wait(800);
    await shot(P[3], '31-play-boom');
    // Identidad
    await launch('Prueba parejas');
    await d.eval(`emit('director:reveal_options'); return 1;`); await wait(5500);
    await P[1].eval(`hzPlace(HZ.pool[0], 0); await new Promise(r=>setTimeout(r,200)); hzPlace(HZ.pool[0], 1); return 1;`); await wait(800);
    await shot(P[1], '32-play-identidad');
    await d.eval(`emit('director:reveal_answer'); return 1;`); await wait(1000);
    for (let k = 0; k < 4; k++) { await d.eval(`emit('director:reveal_next_pair'); return 1;`); await wait(700); } await wait(600);
    await shot(s, '33-screen-identidad');
    // Precio justo en el coordinador
    await launch('Precio Justo — Ronda 1');
    await shot(d, '14-director-precio');
    // Sin pantalla: escenario en el iPad
    await d.eval(`emit('director:set_no_screen',{on:true}); return 1;`);
    await launch('Adivina la película');
    await d.eval(`imagenRevealAll ? 0 : 0; [0,1,2,4,5,7,8,10,11,13,14,16,17,19].forEach(i => emit('director:image_reveal_tile',{tileIndex:i})); emit('director:open_buzzer'); return 1;`); await wait(3500);
    await shot(P[0], '34-play-sin-pantalla');
    await d.eval(`emit('director:set_no_screen',{on:false}); return 1;`); await wait(500);
}

async function partAclara() {
    console.log('Imagen que se aclara');
    const d = await newPage(); await d.size(1366, 768); await login(d);
    await d.go(B + '/director/' + ACLARA, 3500); await skipPreload(d); await wait(800);
    await d.eval(`const el=[...document.querySelectorAll('*')].find(x=>x.children.length===0 && x.textContent.trim()==='Se aclara' && x.offsetParent); el.click(); await new Promise(r=>setTimeout(r,800)); const b=[...document.querySelectorAll('button')].find(x=>/Empezar ronda/.test(x.textContent)&&x.offsetParent); if(b) b.click(); return 1;`);
    await wait(1500);
    await d.eval(`emit('director:aclara_set',{level:0.35}); return 1;`); await wait(1500);
    await shot(d, '35-director-aclara');
}

async function partKit() {
    console.log('Acceso, descargas y kit');
    const a = await newIsolatedPage(); await a.size(1366, 768);   // sin sesión
    await a.go(B + '/login/', 1200);
    await shot(a, '38-acceso', await around(a, '.card', 40));
    const p = await newPage(); await p.size(1366, 768); await login(p);
    await p.go(B + '/', 1200);
    await shot(p, '39-portada');
    await p.go(B + '/admin/', 2000);
    // El kit se monta la primera vez que se pide (unos segundos): esperar a «Listo»
    await p.eval(`openDownloadsModal(); for (let i = 0; i < 90; i++) { if (/Listo/.test(document.getElementById('dl-kit-status').textContent)) break; await new Promise(r => setTimeout(r, 1000)); } return 1;`);
    await shot(p, '40-descargas', await around(p, '#modal-downloads-overlay .modal'));
    await p.eval(`closeDownloadsModal(); return 1;`);
    // Juego offline de verdad, pero sin guardar la descarga
    await p.send('Page.setDownloadBehavior', { behavior: 'deny' });
    await p.eval(`openOfflineModal('${GAME}'); for (let i = 0; i < 60; i++) { if (/Descargando/.test(document.getElementById('offline-title').textContent)) break; await new Promise(r => setTimeout(r, 1000)); } return 1;`);
    await wait(500);
    await shot(p, '41-juego-offline', await around(p, '#modal-offline-overlay .modal'));
}

(async () => {
    const edge = await launch(path.join(require('os').tmpdir(), 'gameshow-capturas-edge'));
    try {
        if (only === 'todo' || only === 'kit') await partKit();
        if (only === 'todo' || only === 'admin') await partAdmin();
        if (only === 'todo' || only === 'juego') await partJuego();
        if (only === 'todo' || only === 'aclara') await partAclara();
    } finally { await closeAll(); await wait(500); try { edge.kill(); } catch (e) {} }
    process.exit(0);
})().catch(async e => { console.error(e); await closeAll(); process.exit(1); });
