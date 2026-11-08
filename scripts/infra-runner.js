import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SERVICES = [
  { name: "infra-github",            port: 3100, dir: "infra-github",            script: "server.js" },
  { name: "infra-firebase",          port: 3200, dir: "infra-firebase",          script: "server.js" },
  { name: "infra-project-creator",   port: 3300, dir: "infra-project-creator",   script: "server.js" },
  { name: "infra-domain-manager",    port: 3400, dir: "infra-domain-manager",    script: "server.js" },
  { name: "api-design-assets",       port: 3500, dir: "api-design-assets",       script: "server.js" },
  { name: "api-conocimiento-rag",    port: 3600, dir: "api-conocimiento-rag",    script: "server.js" },
  { name: "api-utilidades-scraping", port: 3700, dir: "api-utilidades-scraping", script: "server.js" },
  { name: "infra-gateway",           port: 3000, dir: "infra-gateway",           script: "server.js" }
];

// Servicios que requieren configuración de variables de entorno (.env)
const SERVICES_REQUIRING_ENV = [
  "infra-github",
  "infra-firebase",
  "infra-domain-manager"
];

// Colores ANSI para salida por consola
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m"
};

/**
 * Comprueba de manera asíncrona si un puerto está en uso.
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(350);
    client.once('connect', () => {
      client.destroy();
      resolve(true);
    });
    client.once('timeout', () => {
      client.destroy();
      resolve(false);
    });
    client.once('error', () => {
      client.destroy();
      resolve(false);
    });
    client.connect(port, '127.0.0.1');
  });
}

/**
 * Comprueba si un servicio responde correctamente a /ping.
 */
async function isServiceResponding(port) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 400);
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: controller.signal });
    clearTimeout(id);
    if (res.ok) {
      const data = await res.json();
      return data && (data.status === 'ok' || data.gateway === 'online' || data.success === true);
    }
  } catch {
    // Ignorar fallos
  }
  return false;
}

/**
 * Espera los milisegundos especificados.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Envía una petición POST /api/shutdown para apagar de forma limpia un servicio.
 */
async function sendShutdownRequest(port) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 900);
    const endpoint = port === 3000 ? '/api/gateway/shutdown' : '/api/shutdown';
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      signal: controller.signal
    });
    clearTimeout(id);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Obtiene un mapa de puerto -> lista de PIDs en escucha (una sola llamada a netstat en Windows).
 */
function getListeningPidsByPort(ports) {
  const portSet = new Set(ports);
  const pidMap = new Map();
  for (const p of ports) pidMap.set(p, new Set());

  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const stdout = execSync('netstat -ano -p tcp', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('TCP')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1];
        const foreignAddress = parts[2];
        const pid = parts[parts.length - 1];
        // En sockets en escucha, la dirección remota termina en :0 o :*
        if (!foreignAddress.endsWith(':0') && !foreignAddress.endsWith(':*')) continue;
        const colonIdx = localAddress.lastIndexOf(':');
        if (colonIdx !== -1 && pid && pid !== '0' && /^\d+$/.test(pid)) {
          const portNum = Number(localAddress.slice(colonIdx + 1));
          if (portSet.has(portNum)) {
            pidMap.get(portNum).add(pid);
          }
        }
      }
    } else {
      for (const port of ports) {
        try {
          const out = execSync(`lsof -t -i:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          if (out) {
            out.split('\n').forEach((pid) => pid && pidMap.get(port).add(pid.trim()));
          }
        } catch {
          // Puerto sin proceso
        }
      }
    }
  } catch {
    // Ignorar errores de inspección
  }
  return pidMap;
}

/**
 * Detiene forzosamente los procesos asociados a un puerto.
 */
function killPortPids(pids) {
  if (!pids || pids.size === 0) return false;
  const isWin = process.platform === 'win32';
  let killedAny = false;
  for (const pid of pids) {
    try {
      if (isWin) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
      killedAny = true;
    } catch {
      // El proceso ya terminó
    }
  }
  return killedAny;
}

/**
 * Realiza la rotación del archivo log de un servicio si este supera los 5MB.
 */
function rotateLogIfNeeded(serviceName) {
  const logDir = path.join(ROOT, '.infra-logs');
  const logFile = path.join(logDir, `${serviceName}.log`);
  const logFileOld = path.join(logDir, `${serviceName}.log.old`);

  try {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 5 * 1024 * 1024) {
        if (fs.existsSync(logFileOld)) {
          fs.unlinkSync(logFileOld);
        }
        fs.renameSync(logFile, logFileOld);
        console.log(`  ${colors.gray}[LOG]     Rotado archivo de log de ${serviceName} (>5MB)${colors.reset}`);
      }
    }
  } catch (err) {
    console.error(`  ${colors.red}[LOG ERROR] No se pudo rotar el log de ${serviceName}: ${err.message}${colors.reset}`);
  }
}

/**
 * Prepara los scripts de lanzamiento de un servicio y devuelve la ruta del VBS (Windows) o lanza el proceso (Unix).
 */
function prepareOrSpawnService(svc, svcPath, logFile) {
  const logDir = path.dirname(logFile);
  if (process.platform === 'win32') {
    const tempBinDir = path.join(logDir, 'temp-bin');
    if (!fs.existsSync(tempBinDir)) {
      fs.mkdirSync(tempBinDir, { recursive: true });
    }

    const batFile = path.join(tempBinDir, `start-${svc.name}.bat`);
    const batContent = `@echo off\r\nset PORT=${svc.port}\r\ncd /d "${svcPath}"\r\n"${process.execPath}" ${svc.script} >> "${logFile}" 2>&1\r\n`;
    fs.writeFileSync(batFile, batContent, 'utf-8');

    const vbsFile = path.join(tempBinDir, `start-${svc.name}.vbs`);
    const vbsContent = `CreateObject("Wscript.Shell").Run "cmd.exe /c ""${batFile}""", 0, False\r\n`;
    fs.writeFileSync(vbsFile, vbsContent, 'utf-8');
    return vbsFile;
  } else {
    const logFd = fs.openSync(logFile, 'a');
    try {
      const child = spawn(process.execPath, [svc.script], {
        cwd: svcPath,
        env: { ...process.env, PORT: String(svc.port) },
        detached: true,
        stdio: ['ignore', logFd, logFd]
      });
      child.unref();
    } finally {
      try {
        fs.closeSync(logFd);
      } catch {
        // Ignorar
      }
    }
    return null;
  }
}

/**
 * Ejecuta en lote todos los scripts VBS pendientes mediante una única invocación de PowerShell/WMI en Windows ARM64.
 */
function executeWindowsBatchSpawn(vbsFiles) {
  if (!vbsFiles || vbsFiles.length === 0) return;
  try {
    const cimCommands = vbsFiles
      .map((vbs) => `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='wscript.exe "${vbs}"'} | Out-Null`)
      .join('; ');
    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cimCommands.replace(/"/g, '\\"')}"`, {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch {
    for (const vbsFile of vbsFiles) {
      const child = spawn('wscript.exe', [vbsFile], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
    }
  }
}

/**
 * Arranca los microservicios de la infraestructura en paralelo.
 */
async function startAll(targetSvcName) {
  const isGlobal = !targetSvcName || targetSvcName === 'all';
  const normalizedTarget = isGlobal ? null : targetSvcName;

  if (isGlobal) {
    console.log(`\n${colors.cyan}==================================================${colors.reset}`);
    console.log(`${colors.cyan}     Proyectos IA - Arrancando Infraestructura     ${colors.reset}`);
    console.log(`${colors.cyan}==================================================${colors.reset}\n`);
  } else {
    console.log(`\n${colors.cyan}--- Arrancando servicio individual: ${normalizedTarget} ---${colors.reset}\n`);
  }

  const logDir = path.join(ROOT, '.infra-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const targetServices = normalizedTarget
    ? SERVICES.filter((s) => s.name === normalizedTarget)
    : SERVICES;

  // Comprobar estado inicial de puertos en paralelo
  const initialStates = await Promise.all(
    targetServices.map(async (svc) => {
      const svcPath = path.join(ROOT, svc.dir);
      const exists = fs.existsSync(svcPath);
      if (!exists) return { svc, svcPath, exists: false, inUse: false, responding: false };
      const inUse = await isPortInUse(svc.port);
      const responding = inUse ? await isServiceResponding(svc.port) : false;
      return { svc, svcPath, exists: true, inUse, responding };
    })
  );

  const pendingVbsFiles = [];

  for (const { svc, svcPath, exists, inUse, responding } of initialStates) {
    if (!exists) {
      console.log(`  ${colors.yellow}[WARN] ${svc.name}: carpeta no encontrada (${svc.dir})${colors.reset}`);
      continue;
    }

    if (inUse) {
      if (responding) {
        console.log(`  ${colors.green}[OK] ${svc.name.padEnd(23)} ya corriendo en puerto ${svc.port}${colors.reset}`);
      } else {
        console.log(`  ${colors.red}[COLLISION] ${svc.name.padEnd(23)}: puerto ${svc.port} ocupado por un proceso externo.${colors.reset}`);
      }
      continue;
    }

    // Auto-Bootstrap JIT (npm install si no existe node_modules ni en el servicio ni en la raíz del workspace)
    const localNodeModules = path.join(svcPath, 'node_modules');
    const rootNodeModules = path.join(ROOT, 'node_modules');
    if (!fs.existsSync(localNodeModules) && !fs.existsSync(rootNodeModules)) {
      console.log(`  ${colors.yellow}[BOOTSTRAP] ${svc.name.padEnd(23)}: node_modules no encontrado. Instalando dependencias...${colors.reset}`);
      try {
        execSync('npm install', { cwd: svcPath, stdio: 'inherit' });
        console.log(`  ${colors.green}[BOOTSTRAP] ${svc.name.padEnd(23)}: dependencias instaladas con éxito.${colors.reset}`);
      } catch (err) {
        console.error(`  ${colors.red}[BOOTSTRAP ERROR] ${svc.name.padEnd(23)}: falló la instalación de dependencias: ${err.message}${colors.reset}`);
        continue;
      }
    }

    // Verificar si el servicio requiere .env y si el archivo existe
    if (SERVICES_REQUIRING_ENV.includes(svc.name)) {
      const envPath = path.join(svcPath, '.env');
      if (!fs.existsSync(envPath)) {
        console.log(`  ${colors.yellow}[WARN]    ${svc.name.padEnd(23)} requiere .env pero el archivo no existe.${colors.reset}`);
      }
    }

    rotateLogIfNeeded(svc.name);

    console.log(`  ${colors.white}[START] Arrancando ${svc.name.padEnd(23)} en puerto ${svc.port}...${colors.reset}`);
    const logFile = path.join(logDir, `${svc.name}.log`);
    const vbsFile = prepareOrSpawnService(svc, svcPath, logFile);
    if (vbsFile) {
      pendingVbsFiles.push(vbsFile);
    }
  }

  // Lanzar todos los servicios pendientes de una sola vez en Windows
  if (pendingVbsFiles.length > 0) {
    executeWindowsBatchSpawn(pendingVbsFiles);
  }

  console.log(`\n${colors.cyan}--- Verificación de servicios ---${colors.reset}\n`);

  // Espera inteligente: comprobar cada 150ms hasta que todos los servicios objetivo estén escuchando (máx. 5s)
  const maxWaitMs = 5000;
  const startWait = Date.now();
  while (Date.now() - startWait < maxWaitMs) {
    const statuses = await Promise.all(targetServices.map((s) => isPortInUse(s.port)));
    if (statuses.every(Boolean)) {
      break;
    }
    await sleep(150);
  }

  const finalStates = await Promise.all(targetServices.map((s) => isPortInUse(s.port)));
  targetServices.forEach((svc, idx) => {
    const inUse = finalStates[idx];
    const padName = svc.name.padEnd(23);
    if (inUse) {
      console.log(`  ${colors.green}[OK]      ${padName} http://localhost:${svc.port}${colors.reset}`);
    } else {
      console.log(`  ${colors.red}[OFFLINE] ${padName} (puerto ${svc.port})${colors.reset}`);
    }
  });

  console.log(`\n${colors.green}==================================================`);
  console.log(`  Gateway disponible en: http://localhost:3000`);
  console.log(`  Health check:          http://localhost:3000/api/health`);
  console.log(`  Logs en:               .infra-logs/`);
  console.log(`  Para detener:          npm run stop`);
  console.log(`==================================================${colors.reset}\n`);
}

/**
 * Detiene los microservicios de forma paralela y limpia.
 */
async function stopAll(targetSvcName) {
  const isGlobal = !targetSvcName || targetSvcName === 'all';
  const normalizedTarget = isGlobal ? null : targetSvcName;

  if (isGlobal) {
    console.log(`\n${colors.yellow}==================================================${colors.reset}`);
    console.log(`${colors.yellow}     Proyectos IA - Deteniendo Infraestructura     ${colors.reset}`);
    console.log(`${colors.yellow}==================================================${colors.reset}\n`);
  } else {
    console.log(`\n${colors.yellow}--- Deteniendo servicio individual: ${normalizedTarget} ---${colors.reset}\n`);
  }

  const targetServices = normalizedTarget
    ? SERVICES.filter((s) => s.name === normalizedTarget)
    : SERVICES;

  // 1. Comprobar en paralelo qué puertos están activos
  const portStates = await Promise.all(
    targetServices.map(async (svc) => ({
      svc,
      inUse: await isPortInUse(svc.port)
    }))
  );

  // 2. Enviar petición de apagado controlado (/api/shutdown) en paralelo a los activos
  const shutdownResults = await Promise.all(
    portStates.map(async ({ svc, inUse }) => {
      if (!inUse) return { svc, status: 'offline' };
      const clean = await sendShutdownRequest(svc.port);
      return { svc, status: clean ? 'stopped' : 'needs_kill' };
    })
  );

  // Espera inteligente (hasta 1.5s) para que los procesos cierren su socket tras /api/shutdown
  const activeToWait = shutdownResults.filter((r) => r.status === 'stopped').map((r) => r.svc.port);
  if (activeToWait.length > 0) {
    const startWait = Date.now();
    while (Date.now() - startWait < 1500) {
      const checks = await Promise.all(activeToWait.map((port) => isPortInUse(port)));
      if (checks.every((inUse) => !inUse)) break;
      await sleep(150);
    }
  }

  // 3. Verificar si alguno sigue ocupando el puerto y forzar su cierre con una única consulta de red
  const remainingChecks = await Promise.all(
    shutdownResults.map(async (item) => ({
      ...item,
      stillInUse: item.status !== 'offline' ? await isPortInUse(item.svc.port) : false
    }))
  );

  const portsNeedingKill = remainingChecks
    .filter((r) => r.stillInUse)
    .map((r) => r.svc.port);

  const pidMap = portsNeedingKill.length > 0 ? getListeningPidsByPort(portsNeedingKill) : new Map();

  let stoppedCount = 0;
  for (const item of remainingChecks) {
    const padName = item.svc.name.padEnd(23);
    if (item.status === 'offline') {
      console.log(`  ${colors.gray}[OFFLINE] ${padName} ya estaba detenido (puerto ${item.svc.port})${colors.reset}`);
    } else if (!item.stillInUse) {
      console.log(`  ${colors.red}[STOPPED] ${padName} detenido limpiamente (/api/shutdown)${colors.reset}`);
      stoppedCount++;
    } else {
      const pids = pidMap.get(item.svc.port);
      const killed = killPortPids(pids);
      if (killed) {
        console.log(`  ${colors.red}[KILLED]  ${padName} detenido forzosamente (puerto ${item.svc.port})${colors.reset}`);
        stoppedCount++;
      } else {
        console.log(`  ${colors.yellow}[WARN]    ${padName} no se pudo detener en puerto ${item.svc.port}${colors.reset}`);
      }
    }
  }

  // Limpieza de carpeta temp-bin legacy si existiera
  const tempBinDir = path.join(ROOT, '.infra-logs', 'temp-bin');
  if (fs.existsSync(tempBinDir)) {
    try {
      fs.rmSync(tempBinDir, { recursive: true, force: true });
    } catch {
      // Ignorar
    }
  }

  console.log(`\n  Se detuvieron ${stoppedCount} servicio(s).\n`);
}

/**
 * Imprime el estado detallado actual de los microservicios (puerto, ping HTTP, latencia y .env).
 */
async function printStatus() {
  console.log(`\n${colors.cyan}--- Estado de la Infraestructura ---${colors.reset}\n`);
  const states = await Promise.all(
    SERVICES.map(async (svc) => {
      const inUse = await isPortInUse(svc.port);
      const requiresEnv = SERVICES_REQUIRING_ENV.includes(svc.name);
      const hasEnv = !requiresEnv || fs.existsSync(path.join(ROOT, svc.dir, '.env'));
      if (!inUse) return { svc, inUse: false, responding: false, latency: null, requiresEnv, hasEnv };
      const start = Date.now();
      const responding = await isServiceResponding(svc.port);
      const latency = Date.now() - start;
      return { svc, inUse: true, responding, latency, requiresEnv, hasEnv };
    })
  );

  for (const { svc, inUse, responding, latency, requiresEnv, hasEnv } of states) {
    const padName = svc.name.padEnd(23);
    const envBadge = requiresEnv
      ? (hasEnv ? `${colors.green}[.env OK]${colors.reset}` : `${colors.yellow}[SIN .env]${colors.reset}`)
      : '';

    if (inUse && responding) {
      console.log(`  ${colors.green}[ONLINE]${colors.reset}  ${padName} puerto ${svc.port} ${colors.gray}(${latency}ms)${colors.reset} ${envBadge}`);
    } else if (inUse) {
      console.log(`  ${colors.yellow}[BUSY]${colors.reset}    ${padName} puerto ${svc.port} (sin respuesta /ping) ${envBadge}`);
    } else {
      console.log(`  ${colors.gray}[STOPPED]${colors.reset} ${padName} (puerto ${svc.port}) ${envBadge}`);
    }
  }
  console.log('');
}

/**
 * Ejecuta el diagnóstico de salud global llamando al API Gateway.
 */
async function printHealth() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/health');
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(`\n  ${colors.red}[ERROR] El API Gateway (puerto 3000) no responde. ¿Está apagado?${colors.reset}\n`);
  }
}

// Lógica de ruteo de comandos
const command = process.argv[2];
const serviceArg = process.argv[3];
switch (command) {
  case 'start':
    await startAll(serviceArg);
    process.exit(0);
    break;
  case 'stop':
    await stopAll(serviceArg);
    process.exit(0);
    break;
  case 'restart':
    await stopAll(serviceArg);
    await sleep(250);
    await startAll(serviceArg);
    process.exit(0);
    break;
  case 'status':
    await printStatus();
    process.exit(0);
    break;
  case 'health':
    await printHealth();
    process.exit(0);
    break;
  default:
    console.log(`\nUso: node infra-runner.js [start | stop | restart | status | health] [service-name | all]\n`);
    process.exit(1);
}
