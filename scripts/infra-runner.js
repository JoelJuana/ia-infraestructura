import { spawn, execSync, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SERVICES = [
  { name: "infra-github",            port: 3100, dir: "infra-github",            cmd: "npm start" },
  { name: "infra-firebase",          port: 3200, dir: "infra-firebase",          cmd: "npm start" },
  { name: "infra-project-creator",   port: 3300, dir: "infra-project-creator",   cmd: "npm start" },
  { name: "infra-domain-manager",    port: 3400, dir: "infra-domain-manager",    cmd: "npm start" },
  { name: "api-design-assets",       port: 3500, dir: "api-design-assets",       cmd: "npm start" },
  { name: "api-conocimiento-rag",    port: 3600, dir: "api-conocimiento-rag",    cmd: "npm start" },
  { name: "api-utilidades-scraping", port: 3700, dir: "api-utilidades-scraping", cmd: "npm start" },
  { name: "infra-gateway",           port: 3000, dir: "infra-gateway",           cmd: "npm start" }
];

// Servicios que requieren configuración de variables de entorno (.env)
const SERVICES_REQUIRING_ENV = [
  "infra-github",
  "infra-firebase",
  "infra-domain-manager",
  "api-conocimiento-rag"
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
    client.setTimeout(400);
    client.once('connect', () => {
      client.destroy();
      resolve(true); // Conectó, por lo tanto está en uso
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
 * Espera los milisegundos especificados.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Envía una petición POST /api/shutdown para apagar de forma limpia un servicio.
 */
async function sendShutdownRequest(port) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 1000);
    const path = port === 3000 ? '/api/gateway/shutdown' : '/api/shutdown';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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
 * Detiene un proceso forzadamente según su puerto (específico del SO).
 */
function killPort(port) {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      const stdout = execSync('netstat -ano').toString();
      const lines = stdout.split('\n');
      const pids = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.includes('LISTENING')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1];
        const pid = parts[4];
        if (localAddress.endsWith(`:${port}`) && pid && pid !== '0') {
          pids.push(pid);
        }
      }
      const uniquePids = [...new Set(pids)];
      for (const pid of uniquePids) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      }
    } else {
      execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
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
      // 5MB = 5 * 1024 * 1024 bytes
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
 * Arranca los microservicios de la infraestructura.
 */
async function startAll(targetSvcName) {
  const isGlobal = !targetSvcName;
  if (isGlobal) {
    console.log(`\n${colors.cyan}==================================================${colors.reset}`);
    console.log(`${colors.cyan}     Proyectos IA - Arrancando Infraestructura     ${colors.reset}`);
    console.log(`${colors.cyan}==================================================${colors.reset}\n`);
  } else {
    console.log(`\n${colors.cyan}--- Arrancando servicio individual: ${targetSvcName} ---${colors.reset}\n`);
  }

  const logDir = path.join(ROOT, '.infra-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  for (const svc of SERVICES) {
    if (targetSvcName && svc.name !== targetSvcName) {
      continue;
    }
    const svcPath = path.join(ROOT, svc.dir);

    if (!fs.existsSync(svcPath)) {
      console.log(`  ${colors.yellow}[WARN] ${svc.name}: carpeta no encontrada (${svc.dir})${colors.reset}`);
      continue;
    }

    const inUse = await isPortInUse(svc.port);
    if (inUse) {
      console.log(`  ${colors.green}[OK] ${svc.name.padEnd(23)} ya corriendo en puerto ${svc.port}${colors.reset}`);
      continue;
    }

    // Verificar si el servicio requiere .env y si el archivo existe
    if (SERVICES_REQUIRING_ENV.includes(svc.name)) {
      const envPath = path.join(svcPath, '.env');
      if (!fs.existsSync(envPath)) {
        console.log(`  ${colors.yellow}[WARN]    ${svc.name.padEnd(23)} requiere .env pero el archivo no existe.${colors.reset}`);
      }
    }

    // Rotar archivos de logs si exceden 5MB antes de arrancar
    rotateLogIfNeeded(svc.name);

    console.log(`  ${colors.white}[START] Arrancando ${svc.name.padEnd(14)} en puerto ${svc.port}...${colors.reset}`);

    const logFile = path.join(logDir, `${svc.name}.log`);
    const escapedLogFile = logFile.replace(/\\/g, '/');

    if (process.platform === 'win32') {
      // En Windows, creamos un script .bat temporal y un archivo .vbs para lanzar el proceso de forma oculta y persistente.
      // Esto previene ventanas negras molestas en primer plano y asegura la ejecución en background.
      const tempBinDir = path.join(logDir, 'temp-bin');
      if (!fs.existsSync(tempBinDir)) {
        fs.mkdirSync(tempBinDir, { recursive: true });
      }
      
      const batFile = path.join(tempBinDir, `start-${svc.name}.bat`);
      const batContent = `@echo off\r\ncd /d "${svcPath}"\r\n${svc.cmd} > "${logFile}" 2>&1\r\n`;
      fs.writeFileSync(batFile, batContent, 'utf-8');

      const vbsFile = path.join(tempBinDir, `start-${svc.name}.vbs`);
      const vbsContent = `CreateObject("Wscript.Shell").Run "cmd.exe /c ""${batFile}""", 0, False\r\n`;
      fs.writeFileSync(vbsFile, vbsContent, 'utf-8');

      const winCmd = `wscript.exe "${vbsFile}"`;
      const child = exec(winCmd, { windowsHide: true });
      child.unref();
    } else {
      // En Unix/macOS, el spawn detached estándar con redirección de shell funciona perfectamente
      const fullCommand = `${svc.cmd} > "${escapedLogFile}" 2>&1`;
      const child = spawn(fullCommand, {
        cwd: svcPath,
        detached: true,
        stdio: 'ignore',
        shell: true
      });
      child.unref();
    }

    await sleep(500);
  }

  console.log(`\n${colors.cyan}--- Verificación de servicios ---${colors.reset}\n`);
  await sleep(1000);

  for (const svc of SERVICES) {
    const inUse = await isPortInUse(svc.port);
    const padName = svc.name.padEnd(23);
    if (inUse) {
      console.log(`  ${colors.green}[OK]      ${padName} http://localhost:${svc.port}${colors.reset}`);
    } else {
      console.log(`  ${colors.red}[OFFLINE] ${padName} (puerto ${svc.port})${colors.reset}`);
    }
  }

  console.log(`\n${colors.green}==================================================`);
  console.log(`  Gateway disponible en: http://localhost:3000`);
  console.log(`  Health check:          http://localhost:3000/api/health`);
  console.log(`  Logs en:               .infra-logs/`);
  console.log(`  Para detener:          npm run stop`);
  console.log(`==================================================${colors.reset}\n`);}

/**
 * Detiene todos los microservicios.
 */
async function stopAll(targetSvcName) {
  const isGlobal = !targetSvcName;
  if (isGlobal) {
    console.log(`\n${colors.yellow}==================================================${colors.reset}`);
    console.log(`${colors.yellow}     Proyectos IA - Deteniendo Infraestructura     ${colors.reset}`);
    console.log(`${colors.yellow}==================================================${colors.reset}\n`);
  } else {
    console.log(`\n${colors.yellow}--- Deteniendo servicio individual: ${targetSvcName} ---${colors.reset}\n`);
  }

  let stoppedCount = 0;

  for (const svc of SERVICES) {
    if (targetSvcName && svc.name !== targetSvcName) {
      continue;
    }
    const inUse = await isPortInUse(svc.port);
    const padName = svc.name.padEnd(23);

    if (inUse) {
      // Intentar primero apagado controlado
      const cleanShutdown = await sendShutdownRequest(svc.port);
      if (cleanShutdown) {
        console.log(`  ${colors.red}[STOPPED] ${padName} detenido limpiamente (/api/shutdown)${colors.reset}`);
        stoppedCount++;
        await sleep(500);
        continue;
      }

      // Si no responde, forzar cierre del puerto
      const forceKilled = killPort(svc.port);
      if (forceKilled) {
        console.log(`  ${colors.red}[KILLED]  ${padName} detenido forzosamente (puerto ${svc.port})${colors.reset}`);
        stoppedCount++;
      } else {
        console.log(`  ${colors.yellow}[WARN]    ${padName} no se pudo detener en puerto ${svc.port}${colors.reset}`);
      }
    } else {
      console.log(`  ${colors.gray}[OFFLINE] ${padName} ya estaba detenido (puerto ${svc.port})${colors.reset}`);
    }
  }

  // Limpieza de scripts temporales .bat de Windows
  const tempBinDir = path.join(ROOT, '.infra-logs', 'temp-bin');
  if (fs.existsSync(tempBinDir)) {
    try {
      fs.rmSync(tempBinDir, { recursive: true, force: true });
    } catch (e) {
      // Ignorar fallos si algún archivo está momentáneamente bloqueado
    }
  }

  console.log(`\n  Se detuvieron ${stoppedCount} servicio(s).\n`);
}

/**
 * Imprime el estado actual de los microservicios.
 */
async function printStatus() {
  console.log(`\n${colors.cyan}--- Estado de la Infraestructura ---${colors.reset}\n`);
  for (const svc of SERVICES) {
    const inUse = await isPortInUse(svc.port);
    const padName = svc.name.padEnd(23);
    if (inUse) {
      console.log(`  ${colors.green}[RUNNING]${colors.reset} ${padName} en puerto ${svc.port}`);
    } else {
      console.log(`  ${colors.gray}[STOPPED]${colors.reset} ${padName} (puerto ${svc.port})`);
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
  case 'stop':
    await stopAll(serviceArg);
    process.exit(0);
  case 'status':
    await printStatus();
    process.exit(0);
  case 'health':
    await printHealth();
    process.exit(0);
  default:
    console.log(`\nUso: node infra-runner.js [start | stop | status | health] [service-name]\n`);
    process.exit(1);
}
