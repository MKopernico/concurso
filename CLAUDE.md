# GameShow — guía para desarrollar

Plataforma de concursos en directo para eventos escolares (Kopérnico: Natuaventura / Respira Ocio).
Un coordinador dirige desde tablet, 10-50 equipos juegan desde iPads, un PC con proyector muestra la sala.
El usuario no programa: Claude programa, prueba y **pregunta siempre antes de subir** (push a `main` = despliegue en Render).

## Arquitectura

- **Node 24 + Express + Socket.io + better-sqlite3**. Frontend: HTML monolíticos con JS vanilla (sin build).
- `server.js` — arranque, rutas estáticas, guardas de acceso, carga opcional de `.env`.
- `paths.js` — dónde viven los datos: `GAMESHOW_DATA_DIR` (kit) → `/data` (Render) → repo (`db/`, `uploads/`).
- `db/` — `schema.sql` (games, rounds, questions, sessions, teams, settings) e `index.js`.
- `auth.js` + `routes/auth.js` — contraseña general (hash scrypt en `settings`, cambiable desde backoffice; `ADMIN_PASSWORD` del entorno = llave maestra siempre válida), cookie de sesión firmada HMAC (12 h deslizante, la "época" invalida sesiones al cambiar contraseña) y **pase de juego** para iPads (HMAC de gameId + código de acceso).
- `routes/games.js` (CRUD, Excel, sesiones, `/join`, `/public`), `routes/uploads.js` (subidas, biblioteca, `/assets` para precarga), `routes/transfer.js` (exportar/importar `.zip`).
- `sockets/game.js` — **toda la lógica en tiempo real**: estado por juego en memoria (`gameStates`), pulsador, temporizador, puntuación, bonos, premios, ruleta, identidad, karaoke, reconexiones.
- Vistas: `public/admin` (backoffice), `public/director` (+ `chaos.html`, reproductor de música), `public/play` (iPads, PWA con `sw.js`), `public/screen` (proyector), `public/login`, `public/manual`, `public/kit`.
- `public/shared/` — `asset-preloader.js` (precarga verificada), `media-sw-core.js` / `media-sw.js` (service workers de contenido, con respuestas 206), `staff-session.js`, `question-validation.js` (compartido servidor/cliente), `roulette-panel.js`, `gameshow-transitions.js`.
- `kit/` + `tools/build-kit.js` — kit offline para Windows (genera `../GameShow-Offline` con node portátil; nunca toca `datos/`).

## Modelo de acceso (no romperlo)

- `/admin`, `/director`, `/` y la API exigen sesión, salvo `PUBLIC_API` en `auth.js` (lista de juegos activos, `/public`, `/join`, `/assets`, subida de foto con pase, auth).
- Sockets: `socket.use` rechaza `director:*` / `admin_*` sin sesión **revalidada en cada orden**. Los iPads necesitan pase en el handshake para unirse a la sala; la pantalla entra con `screen:join`.
- `playerView(state, forPlayers)`: a los iPads **nunca** les llega la solución (frase de ruleta enmascarada, imagen de "Adivina la imagen", orden de Boom/Identidad barajado y traducido en servidor con `toCanonicalOrder`). La pantalla recibe la vista completa (es pública: riesgo aceptado).
- `deviceId` / `socketId` de los equipos son **no enumerables** (función `team()`): no salen en ningún emit.
- `esc()` escapa comillas; nunca meter datos de usuario dentro de un `onclick` (usar `data-*`).

## Reglas de juego decididas por el usuario

- Pulsador: quien falla no puede volver a pulsar en esa pregunta (`ds.buzzerFailed`).
- Ruleta, imagen fija y demás tipos sin temporizador (`NO_TIMER_TYPES`): el acierto suma solo puntos base.
- Multirespuesta con varias correctas: vale cualquiera.
- Volver a una pregunta ya puntuada la muestra revelada (`ds.questionResults`, `restoreQuestionResult`) y no se vuelve a puntuar.
- "▶ Jugar" con partida en marcha la continúa; partida nueva solo explícita (`resetGameForNewSession` reinicia el estado **en su sitio**: los sockets guardan referencia al objeto).

## Robustez que ya existe

- Marcador, bonos, congelaciones, rondas jugadas y resultados por pregunta se guardan en `sessions.state` cada 2 s y al apagar (SIGTERM/SIGINT/SIGHUP/SIGBREAK), y se restauran al arrancar.
- Handlers de socket envueltos en try/catch + `uncaughtException` registrado: un dato malformado no tumba el proceso. El kit se reinicia solo (`ARRANCAR.bat`, código 2 = no reintentar).
- Órdenes del coordinador ligadas a pregunta llevan `{at, round}` y se descartan si ya no coinciden (doble toque).
- `broadcastDirector` agrupa envíos (máx. uno cada 50 ms): imprescindible con muchos iPads.
- Reconexión del mismo iPad: `takeOverTeam` cierra la conexión vieja (antes daba `slot_taken`).

## Probar (obligatorio tras tocar lógica)

```
node tools/tests/test-lote1.js     # 26 comprobaciones (temporizador, persistencia, reconexión, seguridad…)
node tools/tests/test-lote2.js     # 23 (reglas, fugas de solución, coordinador)
node tools/tests/test-lote3.js     # 21 (backoffice, Excel, zip, sesiones)
node tools/tests/load-test.js 50   # N iPads simulados: entrada, respuestas, pulsador, bonos, reconexión masiva
node tools/tests/soak-test.js 15   # resistencia: partida larga (minutos) con los 10 tipos; memoria, temporizadores, latencias, marcador
node tools/tests/chaos-test.js 10  # red caótica: cortes al azar, zombis, retraso; puntos, equipos y errores
```
Las dos últimas usan `tools/tests/sim-common.js` (iPad y coordinador simulados) y `tools/tests/probe.js` (mide el servidor por dentro vía IPC); dejan el detalle en `tmp/pruebas/*.json`.
Cada script arranca su propio servidor (puertos 3200-3400) con BD temporal; no tocan datos reales.
Para ver cambios visuales: servidor de desarrollo con `.claude/launch.json` (puerto 3000) y el navegador integrado.
La contraseña local de desarrollo está en `.env` (no se sube).

## Subir y desplegar

- Rama de trabajo → tag de seguridad (`git tag -a v-antes-…`) → pruebas → **preguntar al usuario** → merge a `main` y push. Render despliega solo.
- Producción: https://concurso-cf82.onrender.com. Comprobar tras subir: `/ping`, `/admin/` redirige a `/login/`, versión del SW en `/play/sw.js`.
- No usar la contraseña de producción (no la tenemos ni debemos pedirla).
- Tras cambios, regenerar el kit: `node tools/build-kit.js` (con el kit cerrado; si está abierto se detiene sin romper nada).

## Trampas conocidas

- **Versión del service worker de `/play`**: subir `CACHE_NAME` en `public/play/sw.js` cuando cambien `play/index.html` o archivos de su `SHELL` (incluido `shared/asset-preloader.js`).
- Muchos HTML usan **saltos de línea CRLF**: editar con la herramienta Edit o scripts que preserven CRLF. Las barras invertidas en heredocs de Bash se pierden: escribir los scripts a archivo.
- En el kit se entra por `http://IP`: **sin service worker, Cache Storage, portapapeles ni micrófono**. La precarga usa entonces la caché HTTP (`cache: 'no-cache'`).
- Windows marca las redes nuevas como "Pública" y el firewall bloquea a los iPads: el kit avisa al arrancar.
- `better-sqlite3` es nativo: el kit copia el mismo `node.exe` con el que se compiló (Node 24, x64). No hay Visual Studio C++ en el equipo.
- `publicView` (con soluciones) solo va a coordinadores; no emitir estado completo a `roomOf(gameId)`.

## Documentación

- Manual de monitores: `public/manual/index.html` (servido en `/manual/`). Actualizarlo cuando cambie el comportamiento visible.
- Revisión exhaustiva de octubre 2026: `../revision-codigo-2026-10.md`.
- Instrucciones del kit: `kit/LEEME.txt`.
