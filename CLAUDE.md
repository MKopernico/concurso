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
- **Sistema de puntos** (config de ronda/pregunta: `points` (500 por defecto), `fastestExtra` (por defecto sí), `penalty`; resolución en `QuestionValidation.questionPoints` / `fastestExtraOf`, compartido servidor/backoffice/coordinador). Acertar con tiempo = mitad fija + mitad según la rapidez (`speedPoints`, milésimas); +10 % (`extraPoints`) al más rápido de los que lo aciertan todo. `answerScores` calcula multirespuesta/precio/boom/identidad de una vez: de ahí salen el marcador (`autoScore*`) y lo que ve cada iPad (`computeLastQuestionScores`). Precio: ganan todos los de la mejor cifra (puntos enteros; `precioWinners`), extra al primero. Identidad parcial: parte fija × aciertos ÷ parejas. Abierta: puntos × aciertos ÷ subpreguntas + extra al que más acierta. Pulsador y `NO_TIMER_TYPES`: puntos enteros, sin extra; aclara: según nitidez; Pictionary con tiempo: mitad fija + rapidez desde que pulsó.
- «🎯 Puntos» (backoffice, dentro del juego): `PUT /api/games/:id/points { points, fastestExtra, allGames? }` pone esos puntos en todas las rondas (de ese juego o de todos), quita los antiguos y los puntos propios de las preguntas (heredan); no toca penalización, tiempos ni premio. Así se pasan a 500 los juegos de producción (no tenemos su contraseña).
- Juegos y Excel antiguos (`basePoints` + `bonusMax`): no se migran; se convierten al vuelo (puntos = base + bonus; en pulsador, sin tiempo, aclara, abierta y Pictionary sin tiempo, solo base). Excel: mismas columnas, cabeceras `puntos` / `extra_mas_rapido` (si/no); si la cabecera dice `puntos_base`/`bonus_max`, se guarda como antiguo (`isLegacyPointsHeader`).
- Multirespuesta con varias correctas: vale cualquiera.
- Boom e Identidad en el iPad: arrastrar a huecos (componente `HZ` en `play/index.html`, tamaño con `hzFit`). En Identidad el orden puede llevar huecos vacíos (`null`): no puntúan; `toCanonicalOrder` rechaza repetidos. «Imagen que se aclara» (tipo `aclara`): `ds.aclara` en servidor (nitidez calculada al enviar, el cliente la anima con `shared/aclara-fx.js`); puntos con `aclaraPoints`. Boom se revela por pasos (`ds.boomStep`, mismo botón que Identidad: `director:reveal_next_pair`); a los iPads solo les llega lo destapado del orden.
- Respuestas fuera de sitio (`answerOutOfPlace` en `sockets/game.js`): el iPad manda en `k` la `questionKey` de la pregunta a la que responde (lo añade `emit()` de play a todo lo de `_QUEUEABLE`); el servidor descarta las de otra pregunta (mensaje que llega tarde tras pasar a la siguiente) y, en multirespuesta/Boom/Identidad, las que llegan antes de «Abrir opciones». Sin `k` (iPad sin actualizar) solo se mira lo de las opciones. La cuenta atrás no se comprueba en el servidor (el iPad ya la bloquea y los simuladores responden durante ella).
- Boom: con todas las posiciones colocadas el iPad manda el orden provisional (`player:update_order`, como Identidad); al cerrar sin «Enviar» cuenta solo la parte fija (`timerRemaining` 0, `late`, hora del cierre: no le quita el extra a quien envió). «Enviar» después lo hace definitivo.
- Color secundario del juego (`--gold` en play y screen): pasa por `GameShowShared.Theme.readableOnDark` (shared/gameshow-transitions.js), que lo mezcla con blanco hasta luminancia ≥ 0,2 (≈ 4,5:1 sobre el fondo oscuro y con letra negra encima). Un azul marino como el de AGROLAND (#0822e2) sale #6b7aee.
- Cabecera del iPad en «Espera» y en la sala (`isOutOfRound`): logo del juego y sin nombre de ronda (antes se quedaba la última ronda lanzada).
- Boom e Identidad: los puntos esperan en `ds.pendingScores` y se suman al revelar la última posición/pareja (`applyPendingScores`); si el coordinador sale de la pregunta antes, se suman al salir. Multirespuesta y Precio puntúan al cerrar.
- Respuesta abierta (tipo `abierta`): `content = { statement?, subs: [{ text, answer, alts? }], time? }` (`alts` = texto con «/»; `time` vacío = sin cuenta atrás). Pasos en `ds.abierta.step`: intro → shown → open → correcting → revealed (`director:abierta_show|open|close|reveal|mark`). Borrador en servidor (`player:abierta_draft`, no se difunde) y envío (`player:abierta_submit`); al cerrar, lo escrito sin enviar cuenta con la hora del cierre. Corrección automática con `QuestionValidation.matchesSub` (sin mayúsculas, tildes, signos). Puntos = puntos × aciertos ÷ subpreguntas (redondeado) + extra (10 %) al que más acierta (empate: el que envió antes), en `pendingScores` hasta revelar la última. Rectificar ya revelada (`rectifyAbierta`) recalcula y suma solo la diferencia. A medio corregir se guarda en `ds.abiertaWip` (persistido).
- Pictionary (tipo `pictionary`): `content = { word, category? }`, una palabra por pregunta. Config de ronda `picMode` equipos|ipad, `picTurns` auto|manual, `picDrawerPoints` (puntos fijos al que dibuja si alguien acierta; en modo ipad nadie los cobra); tiempo por palabra (`picTimeOf`: pregunta > ronda > 60; 0 = sin tiempo). `ds.pictionary = { step: setup|drawing, mode, drawer, drawerPts, pausedByBuzz }`: «Empezar a dibujar» (`director:pic_start`) manda la palabra solo a quien dibuja (`pic:word`), abre el pulsador y arranca el tiempo; el equipo que dibuja no pulsa; al pulsar se para el tiempo y un fallo lo reanuda (`picResume`). Turnos automáticos: `picCandidate` (rueda al azar `ds.picRank`/`picDone`/`picLast`, persistida en el snapshot). La palabra se borra de `playerView` también para la pantalla (los iPads sin pantalla la incrustan). Trazos fuera del estado general (`state._pic`, clave = questionKey): `pic:stroke|undo|clear` → `pic:chunk|op` con secuencia solo a `screens:` y `directors:`; `pic:get` → `pic:full` (el visor lo pide si falta un trozo). Pizarra fija: `/play/pizarra.html?g=&p=&k=` con `auth.padKey` (HMAC del juego + código), `pad:join`, una sola a la vez. Cliente común: `shared/pictionary-board.js|css` (Board, Viewer, Pad).
- Volver a una pregunta ya puntuada la muestra revelada (`ds.questionResults`, `restoreQuestionResult`) y no se vuelve a puntuar.
- Escaleta: la barra «Rondas» del coordinador va en el orden del backoffice (`sort_order`), numerada y sin agrupar por tipo. Cualquier cambio de rondas/preguntas por la API (middleware al principio de `routes/games.js`) llama a `roundsChanged`: recarga `_rounds` y avisa a los coordinadores (`game:rounds_changed` → `reloadRounds`). La pregunta en curso no se toca.
- Tiempo con milésimas: `preciseRemaining` (desde `_tickAt`, el último tic); `answerTiming` interpola los reenvíos; en Pictionary la rapidez cuenta desde que pulsan (`entry.rem`). Resolución = tiempo ÷ (puntos / 2) segundos por punto (500 en 30 s → 0,12 s).
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
node tools/tests/test-pictionary.js # 52 (Pictionary: turnos, palabra solo a quien dibuja, trazos en directo, tiempo parado al pulsar, puntos al que dibuja, pizarra fija por QR, rueda persistida, Excel)
node tools/tests/test-loteF-informe.js  # 17 (resultados por equipo en pulsador; «Mostrar respuesta» de aclara; plantilla Excel con ejemplos; Precio vacío = incompleto)
node tools/tests/test-loteG-escaleta.js # 13 (escaleta en vivo al coordinador/menús; bonus con milésimas sin empates; pulsador desde que pulsan)
node tools/tests/test-loteH-puntos.js  # 29 (sistema de puntos: reparto, extra, precio con empate, identidad parcial, pulsador, juegos y Excel antiguos, «🎯 Puntos» de todo el juego)
node tools/tests/test-loteI-agroland.js # 17 (respuestas tardías o antes de abrir opciones, Boom colocado sin «Enviar», color secundario legible)
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
