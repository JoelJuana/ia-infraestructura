@echo off
title Visor de Infraestructura IA
echo ==================================================
echo      Iniciando Infraestructura Local de IA
echo ==================================================
echo.
cd /d "%~dp0"
call npm run start

echo.
echo ==================================================
echo  Abriendo visor en http://localhost:3000...
echo ==================================================
start http://localhost:3000/

echo.
echo [*] La infraestructura esta corriendo.
echo [*] Puedes ver el estado de salud, consultar logs en vivo y controlar
echo     los servicios directamente desde el navegador.
echo.
echo IMPORTANTE: Deja esta ventana abierta mientras uses el visor.
echo Presiona cualquier tecla en esta ventana para APAGAR los servicios
echo de forma limpia y liberar los puertos.
echo.
pause > nul

echo.
echo ==================================================
echo  Deteniendo todos los servicios de infraestructura...
echo ==================================================
call npm run stop
echo.
echo [OK] Puertos liberados. Adios.
pause
