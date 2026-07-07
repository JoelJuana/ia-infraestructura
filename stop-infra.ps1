# =============================================================================
#  stop-infra.ps1 -- Detiene todos los microservicios del monorepositorio
# =============================================================================

$ports = @(3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700)

$serviceNames = @{
    3000 = "infra-gateway"
    3100 = "infra-github"
    3200 = "infra-firebase"
    3300 = "infra-project-creator"
    3400 = "infra-domain-manager"
    3500 = "api-design-assets"
    3600 = "api-conocimiento-rag"
    3700 = "api-utilidades-scraping"
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Yellow
Write-Host "     Proyectos IA - Deteniendo Infraestructura     " -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Yellow
Write-Host ""

$stopped = 0

foreach ($port in $ports) {
    $name = $serviceNames[$port]
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

    if ($connections) {
        foreach ($conn in $connections) {
            $targetPid = $conn.OwningProcess
            try {
                $process = Get-Process -Id $targetPid -ErrorAction Stop
                Stop-Process -Id $targetPid -Force -ErrorAction Stop
                Write-Host "  [STOPPED] $($name.PadRight(20)) detenido (PID: $targetPid, puerto $port)" -ForegroundColor Red
                $stopped++
            } catch {
                Write-Host "  [WARN]    $($name.PadRight(20)) no se pudo detener PID $targetPid" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  [OFFLINE] $($name.PadRight(20)) ya estaba detenido (puerto $port)" -ForegroundColor DarkGray
    }
}

Write-Host ""
if ($stopped -gt 0) {
    Write-Host "  Se detuvieron $stopped servicio(s)." -ForegroundColor Yellow
} else {
    Write-Host "  No habia servicios activos que detener." -ForegroundColor DarkGray
}
Write-Host ""
