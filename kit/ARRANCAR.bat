@echo off
chcp 65001 >nul
title GameShow - servidor offline (no cerrar)
cd /d "%~dp0"
if not exist "node\node.exe" (
    echo No se encuentra node\node.exe. El kit esta incompleto.
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
