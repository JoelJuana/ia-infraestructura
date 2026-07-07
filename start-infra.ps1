# =============================================================================
#  start-infra.ps1 -- Arranca todos los microservicios del monorepositorio
# =============================================================================

$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = Get-Location }

# Definicion de servicios: nombre de carpeta, puerto esperado y comando de arranque
$services = @(
    @{ Name = "infra-github";         Port = 3100; Dir = "infra-github";            Cmd = "npm start" },
    @{ Name = "infra-firebase";       Port = 3200; Dir = "infra-firebase";          Cmd = "npm start" },
    @{ Name = "infra-project-creator";Port = 3300; Dir = "infra-project-creator";   Cmd = "npm start" },
    @{ Name = "infra-domain-manager"; Port = 3400; Dir = "infra-domain-manager";    Cmd = "npm start" },
    @{ Name = "api-design-assets";    Port = 3500; Dir = "api-design-assets";        Cmd = "npm start" },
    @{ Name = "api-conocimiento-rag"; Port = 3600; Dir = "api-conocimiento-rag";     Cmd = "npm start" },
    @{ Name = "api-utilidades-scraping";Port = 3700;Dir = "api-utilidades-scraping"; Cmd = "npm start" },
    @{ Name = "infra-gateway";        Port = 3000; Dir = "infra-gateway";           Cmd = "npm start" }
)

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "     Proyectos IA - Arrancando Infraestructura     " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

foreach ($svc in $services) {
    $svcPath = Join-Path $ROOT $svc.Dir

    if (-not (Test-Path $svcPath)) {
        Write-Host "  [WARN] $($svc.Name): carpeta no encontrada ($($svc.Dir))" -ForegroundColor Yellow
        continue
    }

    # Comprobar si el puerto ya esta en uso
    $portInUse = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue
    if ($portInUse) {
        Write-Host "  [OK] $($svc.Name): ya corriendo en puerto $($svc.Port)" -ForegroundColor Green
        continue
    }

    Write-Host "  [START] Arrancando $($svc.Name) en puerto $($svc.Port)..." -ForegroundColor White

    # Arrancar como proceso en segundo plano
    $logFile = Join-Path $ROOT ".infra-logs\$($svc.Name).log"
    $logDir  = Split-Path $logFile
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

    $argList = '/c cd /d "' + $svcPath + '" && ' + $svc.Cmd + ' > "' + $logFile + '" 2>&1'
    Start-Process -FilePath "cmd.exe" -ArgumentList $argList -WindowStyle Hidden

    # Esperar brevemente para que el servicio arranque
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "--- Verificacion de servicios ---" -ForegroundColor Cyan
Write-Host ""

Start-Sleep -Seconds 2

foreach ($svc in $services) {
    $portInUse = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue
    $name = $svc.Name
    $port = $svc.Port
    $padName = $name.PadRight(20)
    if ($portInUse) {
        Write-Host "  [OK]      $padName http://localhost:$port" -ForegroundColor Green
    } else {
        Write-Host "  [OFFLINE] $padName (puerto $port)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Gateway disponible en: http://localhost:3000" -ForegroundColor Green
Write-Host "  Health check:          http://localhost:3000/api/health" -ForegroundColor Green
Write-Host "  Logs en:               .infra-logs/" -ForegroundColor Green
Write-Host "  Para detener:          .\stop-infra.ps1" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
