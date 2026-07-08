@echo off
title Visor de Logs IA (Solo Lectura)
echo ==================================================
echo      Iniciando Visor de Logs (Solo Gateway)
echo ==================================================
echo.
cd /d "%~dp0"
echo [*] Iniciando unicamente el servidor del Gateway en puerto 3000...
call node scripts/infra-runner.js start infra-gateway

echo.
echo ==================================================
echo  Abriendo visor en http://localhost:3000...
echo ==================================================
start http://localhost:3000/

echo.
echo [*] El servidor de logs esta activo.
echo [*] Todos los microservicios de desarrollo permanecen APAGADOS.
echo [*] Puedes leer los logs historicos en la web.
echo.
echo Presiona cualquier tecla en esta ventana para APAGAR el visor
echo y liberar el puerto 3000.
echo.
pause > nul

echo.
echo ==================================================
echo  Deteniendo el Gateway de infraestructura...
echo ==================================================
call node scripts/infra-runner.js stop infra-gateway
echo.
echo [OK] Puerto 3000 liberado.
pause
