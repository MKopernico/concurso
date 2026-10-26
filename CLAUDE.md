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
  - `kit/assemble.js` monta el kit: la app **empaquetada con esbuild** en `app/server.js` (con `node_modules` completo eran 4.300 archivos y descomprimir tardaba +3 min; así son ~100 y 5 s) + `public/`, `db/schema.sql`, `socket.io/client-dist`, better-sqlite3 tal cual y `node/node.exe`. Un plugin reescribe `__dirname` de cada módulo a su carpeta original dentro de `app/`. Fuera de Windows (Render) descarga `node.exe` (verificado con SHASUMS256 de nodejs.org) y el binario de better-sqlite3 para Windows de sus releases de GitHub (`KIT_NODE` fija versión y ABI).
  - `routes/kit.js`: **⬇ Descargas › Kit offline** (`/api/kit/status`, `/api/kit/download`) y **💾 Juego offline** (`POST /api/games/:id/offline-kit` → `/api/offline-kit/<token>`, 3 h). El zip vive en `<datos>/kit-cache` (en Render, el disco); en Render se monta solo al arrancar (`RENDER`), en local al pedirlo; se reutiliza mientras no cambie la huella del código. El juego se añade al zip del kit sin recomprimir (`appendStoredFile`) en `datos/importar/`, y `kit/start.js` importa al arrancar lo que haya ahí (lo aparta a `importados/`). Disco: los zips de juego offline (`kit-cache/offline/<huella>.zip`) se reutilizan si el juego no cambia, caducan a las 3 h, no pasan de `GAMESHOW_OFFLINE_CAP_MB` (300) en total (se borran los más antiguos) y se limpian al arrancar, cada 15 min y en `/kit/status`. Fijo en disco: node.exe (~80 MB) + binario sqlite + el zip del kit actual (~40 MB).
- Portada: `/login/` (contraseña + «Soy jugador» → `/play/`) y, con sesión, `/` con «Soy coordinador» y «Backoffice».

## Modelo de acceso (no romperlo)

- `/admin`, `/director`, `/` y la API exigen sesión, salvo `PUBLIC_API` en `auth.js` (lista de juegos activos, `/public`, `/join`, `/assets`, subida de foto con pase, auth).
- Sockets: `socket.use` rechaza `director:*` / `admin_*` sin sesión **revalidada en cada orden**. Los iPads necesitan pase en el handshake para unirse a la sala; la pantalla entra con `screen:join`.
- `playerView(state, forPlayers)`: a los iPads **nunca** les llega la solución (frase de ruleta enmascarada, imagen de "Adivina la imagen", orden de Boom/Identidad barajado y traducido en servidor con `toCanonicalOrder`). La pantalla recibe la vista completa (es pública: riesgo aceptado).
- `deviceId` / `socketId` de los equipos son **no enumerables** (función `team()`): no salen en ningún emit.
- `esc()` escapa comillas; nunca meter datos de usuario dentro de un `onclick` (usar `data-*`).

## Reglas de juego decididas por el usuario

- Pulsador: quien falla no puede volver a pulsar en esa pregunta (`ds.buzzerFailed`); su iPad muestra el botón gris con un aviso fijo. En las pruebas de pulsador `computeLastQuestionScores` apunta al ganador (con `buzzerPoints`) y a los que fallaron.
- Ruleta, imagen fija y demás tipos sin temporizador (`NO_TIMER_TYPES`): el acierto suma solo puntos base.
- Multirespuesta con varias correctas: vale cualquiera.
- Boom e Identidad en el iPad: arrastrar a huecos (componente `HZ` en `play/index.html`, tamaño con `hzFit`). En Identidad el orden puede llevar huecos vacíos (`null`): no puntúan; `toCanonicalOrder` rechaza repetidos. «Imagen que se aclara» (tipo `aclara`): `ds.aclara` en servidor (nitidez calculada al enviar, el cliente la anima con `shared/aclara-fx.js`); puntos con `aclaraPoints`. Boom se revela por pasos (`ds.boomStep`, mismo botón que Identidad: `director:reveal_next_pair`); a los iPads solo les llega lo destapado del orden.
- Boom e Identidad: los puntos esperan en `ds.pendingScores` y se suman al revelar la última posición/pareja (`applyPendingScores`); si el coordinador sale de la pregunta antes, se suman al salir. Multirespuesta y Precio puntúan al cerrar.
- Respuesta abierta (tipo `abierta`): `content = { statement?, subs: [{ text, answer, alts? }], time? }` (`alts` = texto con «/»; `time` vacío = sin cuenta atrás). Pasos en `ds.abierta.step`: intro → shown → open → correcting → revealed (`director:abierta_show|open|close|reveal|mark`). Borrador en servidor (`player:abierta_draft`, no se difunde) y envío (`player:abierta_submit`); al cerrar, lo escrito sin enviar cuenta con la hora del cierre. Corrección automática con `QuestionValidation.matchesSub` (sin mayúsculas, tildes, signos). Puntos = base × aciertos ÷ subpreguntas (redondeado) + `bonusMax` al que más acierta (empate: el que envió antes), en `pendingScores` hasta revelar la última. Rectificar ya revelada (`rectifyAbierta`) recalcula y suma solo la diferencia. A medio corregir se guarda en `ds.abiertaWip` (persistido).
- Volver a una pregunta ya puntuada la muestra revelada (`ds.questionResults`, `restoreQuestionResult`) y no se vuelve a puntuar.
- "▶ Jugar" (único botón de la lista para abrir el coordinador) crea la partida o continúa la que está en marcha, **sin preguntar**: los `confirm()` tras abrir la pestaña nueva los anula el navegador. Partida nueva = «🗑 Borrar todo» del coordinador; la API mantiene `{ nueva: true }` (`resetGameForNewSession` reinicia el estado **en su sitio**: los sockets guardan referencia al objeto).

## Robustez que ya existe

- Marcador, bonos, congelaciones, rondas jugadas y resultados por pregunta se guardan en `sessions.state` cada 2 s y al apagar (SIGTERM/SIGINT/SIGHUP/SIGBREAK), y se restauran al arrancar.
- Handlers de socket envueltos en try/catch + `uncaughtException` registrado: un dato malformado no tumba el proceso. El kit se reinicia solo (`ARRANCAR.bat`, código 2 = no reintentar).
- Órdenes del coordinador ligadas a pregunta llevan `{at, round}` y se descartan si ya no coinciden (doble toque).
- `broadcastDirector` agrupa envíos (máx. uno cada 50 ms): imprescindible con muchos iPads.
- Registro (`logAction` → `ds.bonoLog`, 1000 entradas máx.): al coordinador solo le llegan `logCount` y las 5 últimas; el panel pide el completo con `director:get_log`.
- Reconexión del mismo iPad: `takeOverTeam` cierra la conexión vieja (antes daba `slot_taken`).
- Sin pantalla (`ds.noScreen`, `ds.audioOn` sala|ipads; valor inicial en `theme.noScreen` / `theme.audio`): el iPad incrusta `/screen/<id>?embed=1` como escenario (`updateStage` en play) en los tipos sin contenido propio. La vista incrustada no precarga, no cuenta como pantalla y solo suena si `audioOn === 'ipads'` (`soundAllowed`).
- Equipo a otro iPad: `director:recovery_code` (código en `state._recovery`, 10 min, un uso) → `player:recover_team` cambia el `device_id` del equipo. QR: `/play/?g=&p=&r=`.

## Probar (obligatorio tras tocar lógica)

```
node tools/tests/test-lote1.js     # 26 comprobaciones (temporizador, persistencia, reconexión, seguridad…)
node tools/tests/test-lote2.js     # 23 (reglas, fugas de solución, coordinador)
node tools/tests/test-lote3.js     # 21 (backoffice, Excel, zip, sesiones)
node tools/tests/test-loteA-ensayo.js  # 10 (arreglos del ensayo: acierto cierra pulsador, empate Precio, descongelar)
node tools/tests/test-loteB-ensayo.js  # 8 (resultado en iPads: ganador/puntos del pulsador, respuesta propia, volver a la pregunta)
node tools/tests/test-loteC-huecos.js  # 14 (huecos en Identidad: vacíos, repetidos, reconexión; Boom revelado por pasos)
node tools/tests/test-loteD-registro.js # 11 (registro del coordinador: puntos, aciertos, bonos, congelaciones, reinicios)
node tools/tests/test-loteD-aclara.js   # 15 (Imagen que se aclara: avance, pausa al pulsar, fallo reanuda, puntos por nitidez, modo a mano, Excel)
node tools/tests/test-loteD-recuperar.js # 10 (pasar un equipo a otro iPad con código de un solo uso)
node tools/tests/test-loteE-sinpantalla.js # 9 (modo sin pantalla y dónde suena: backoffice, coordinador, vista incrustada)
node tools/tests/test-abierta.js   # 46 (Respuesta abierta: pasos, borrador, corrección, puntos y bonus, revelado, rectificar, cuenta atrás, Excel)
node tools/tests/test-loteF-informe.js  # 17 (resultados por equipo en pulsador; «Mostrar respuesta» de aclara; plantilla Excel con ejemplos; Precio vacío = incompleto)
node tools/tests/test-kit.js       # 33 (portada/acceso, kit y juego offline: descarga, rangos, CRC, limpieza del disco, y arranca el kit descargado con su node.exe)
node tools/tests/load-test.js 50   # N iPads simulados: entrada, respuestas, pulsador, bonos, reconexión masiva
node tools/tests/soak-test.js 15   # resistencia: partida larga (minutos) con los 10 tipos; memoria, temporizadores, latencias, marcador
node tools/tests/chaos-test.js 10  # red caótica: cortes al azar, zombis, retraso; puntos, equipos y errores
```
Las dos últimas usan `tools/tests/sim-common.js` (iPad y coordinador simulados) y `tools/tests/probe.js` (mide el servidor por dentro vía IPC); dejan el detalle en `tmp/pruebas/*.json`.
Cada script arranca su propio servidor (puertos 3200-3400) con BD temporal; no tocan datos reales.
Con `GAMESHOW_TEST_APP=<kit>/app` todos los scripts prueban la app empaquetada del kit en vez del repo.
Para ver cambios visuales: servidor de desarrollo con `.claude/launch.json` (puerto 3000) y el navegador integrado.
La contraseña local de desarrollo está en `.env` (no se sube).

## Subir y desplegar

- Rama de trabajo → tag de seguridad (`git tag -a v-antes-…`) → pruebas → **preguntar al usuario** → merge a `main` y push. Render despliega solo.
- Producción: https://concurso-cf82.onrender.com. Comprobar tras subir: `/ping`, `/admin/` redirige a `/login/`, versión del SW en `/play/sw.js`.
- No usar la contraseña de producción (no la tenemos ni debemos pedirla).
- Tras cambios, regenerar el kit: `node tools/build-kit.js` (con el kit cerrado; si está abierto se detiene sin romper nada). `node tools/build-kit.js --zip <archivo>` hace el mismo zip que se descarga del backoffice.
- El kit descargable de Render se rehace solo al desplegar (1-2 min tras arrancar). Sin la contraseña de producción no se puede comprobar desde aquí: lo mira el usuario en «⬇ Descargas» (debe decir «Listo» con la versión del commit subido).

## Trampas conocidas

- **Versión del service worker de `/play`**: subir `CACHE_NAME` en `public/play/sw.js` cuando cambien `play/index.html` o archivos de su `SHELL` (incluido `shared/asset-preloader.js`).
- **iOS y el doble toque**: `user-scalable=no` no basta y `touch-action` no se hereda (los contenedores con overflow lo cortan): va en `*`. Play además anula el segundo toque rápido, el pellizco y el arrastre de la página entera en el juego.
- **Sombras y brillos recortados**: un contenedor con `overflow: hidden` corta el `text-shadow`/`box-shadow` de lo que toca su borde. Dar relleno al contenedor (y, si hace falta, margen negativo para no cambiar el ancho).
- Muchos HTML usan **saltos de línea CRLF**: editar con la herramienta Edit o scripts que preserven CRLF. Las barras invertidas en heredocs de Bash se pierden: escribir los scripts a archivo.
- En el kit se entra por `http://IP`: **sin service worker, Cache Storage, portapapeles ni micrófono**. La precarga usa entonces la caché HTTP (`cache: 'no-cache'`).
- Windows marca las redes nuevas como "Pública" y el firewall bloquea a los iPads: el kit avisa al arrancar.
- `better-sqlite3` es nativo: el kit lleva `node.exe` y el binario precompilado de la misma versión de Node (`KIT_NODE` en `kit/assemble.js`; al cambiarla, actualizar también `abi`). No hay Visual Studio C++ en el equipo.
- Código nuevo en el servidor que lea archivos con rutas relativas a `__dirname` funciona en el kit gracias al plugin, pero el archivo tiene que estar en `RUNTIME_DIRS`/`RUNTIME_FILES` de `kit/assemble.js`. Un `require` dinámico (con variable) no se empaqueta. `test-kit.js` y los tests con `GAMESHOW_TEST_APP` lo detectan.
- `publicView` (con soluciones) solo va a coordinadores; no emitir estado completo a `roomOf(gameId)`.

## Documentación

- Manual de monitores: `public/manual/index.html` (servido en `/manual/`). Actualizarlo cuando cambie el comportamiento visible.
- Capturas del manual (`public/manual/img/*.webp`): se rehacen con `node tools/capturas-manual/shot-server.js` (servidor aparte en el puerto 3101 con una copia de `db/games.db` y `uploads/`; usa el juego «Batidora genérica» de la BD local) y, con él en marcha, `node tools/capturas-manual/shots.js` (Edge sin ventana manejado por CDP; partes: `admin`, `juego`, `aclara` o `todo`). Revisar las imágenes al terminar.
- Plantillas Excel: `/api/templates/importacion` (vacía) y `?ejemplo=1` (una pregunta de cada tipo, importable tal cual; imagen de muestra en `/shared/ejemplo-paisaje.svg`). Botones en la lista de juegos, en cada juego y en la ventana de importar.
- Kit: `VERSION.txt` dice con qué commit se generó.
- Revisión exhaustiva de octubre 2026: `../revision-codigo-2026-10.md`.
- Instrucciones del kit: `kit/LEEME.txt`.
