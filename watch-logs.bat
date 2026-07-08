@echo off
title Monitor de Logs de Infraestructura IA
echo ==================================================
echo      Iniciando Monitor de Logs en Tiempo Real
echo ==================================================
echo.
cd /d "%~dp0"
node scripts/watch-logs.js
pause
