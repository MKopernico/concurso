@echo off
chcp 65001 >nul
title GameShow - servidor offline (no cerrar)
cd /d "%~dp0"
if not exist "node\node.exe" (
    echo No se encuentra node\node.exe.
    echo.
    echo Si has abierto ARRANCAR.bat desde dentro del .zip, primero descomprimelo:
    echo boton derecho sobre el .zip ^> "Extraer todo", y abre ARRANCAR.bat en la carpeta extraida.
    echo.
    echo Si ya estaba descomprimido, el kit esta incompleto: vuelve a descargarlo.
    pause
    exit /b 1
)

:arranque
"node\node.exe" "app\kit\start.js"
rem Codigo 2 = problema de configuracion (puerto ocupado, sin contraseña): no reintentar
if %errorlevel%==2 goto fin
echo.
echo GameShow se ha detenido de forma inesperada. Se reinicia en 5 segundos...
echo (El marcador se conserva. Cierra esta ventana si NO quieres que se reinicie.)
timeout /t 5 >nul
rem En los reinicios no se vuelve a abrir el navegador
set GAMESHOW_NO_BROWSER=1
goto arranque

:fin
echo.
echo GameShow se ha detenido.
pause
