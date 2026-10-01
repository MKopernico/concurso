@echo off
chcp 65001 >nul
title GameShow - servidor offline (no cerrar)
cd /d "%~dp0"
if not exist "node\node.exe" (
    echo No se encuentra node\node.exe. El kit esta incompleto.
    pause
    exit /b 1
)
"node\node.exe" "app\kit\start.js"
echo.
echo GameShow se ha detenido.
pause
