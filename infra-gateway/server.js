import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import shared from '../packages/shared/index.cjs';

const {
  LOCAL_HOST,
  createLocalCorsOptions,
  localSecurityMiddleware,
  getProcessMetrics,
  readLogTail
} = shared;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.resolve(__dirname, '..', 'scripts', 'infra-runner.js');
const LOG_DIR = path.resolve(__dirname, '..', '.infra-logs');

/**
 * Ejecuta comandos en el runner usando execFile nativo sin interpolación de shell.
 */
function runServiceCommand(action, serviceName = '') {
  return new Promise((resolve) => {
    const args = [RUNNER_PATH, action];
    if (serviceName) args.push(serviceName);
    execFile(process.execPath, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error al ejecutar runner (${action} ${serviceName}):`, error.message);
        resolve({ ok: false, error: error.message, output: stderr || stdout });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTO_WAKEUP_ENABLED = process.env.GATEWAY_AUTO_WAKEUP !== 'false';

// ─── Watchdog de Auto-Apagado por Inactividad (protección ARM64) ────────────
const IDLE_TIMEOUT_MIN = Number(process.env.GATEWAY_IDLE_TIMEOUT_MIN || 30);
let lastActivityTimestamp = Date.now();

function recordActivity(reqUrl) {
  if (
    reqUrl === '/ping' ||
    reqUrl.startsWith('/api/health') ||
    reqUrl.startsWith('/api/gateway/logs')
  ) {
    return;
  }
  lastActivityTimestamp = Date.now();
}

if (IDLE_TIMEOUT_MIN > 0) {
  const checkInterval = setInterval(async () => {
    const idleMs = Date.now() - lastActivityTimestamp;
    if (idleMs >= IDLE_TIMEOUT_MIN * 60 * 1000) {
      console.log(`[WATCHDOG] Inactividad de ${IDLE_TIMEOUT_MIN} min alcanzada. Apagando suite automáticamente...`);
      clearInterval(checkInterval);
      await runServiceCommand('stop', 'all');
      process.exit(0);
    }
  }, 60 * 1000);
  checkInterval.unref();
}

// ─── Configuración de servicios ─────────────────────────────────────────────
const SERVICES = {
  git:      { target: process.env.SERVICE_GITHUB    || 'http://127.0.0.1:3100', port: 3100, name: 'infra-github', dir: 'infra-github', requiresEnv: true },
  fb:       { target: process.env.SERVICE_FIREBASE   || 'http://127.0.0.1:3200', port: 3200, name: 'infra-firebase', dir: 'infra-firebase', requiresEnv: true },
  proj:     { target: process.env.SERVICE_PROJECTS   || 'http://127.0.0.1:3300', port: 3300, name: 'infra-project-creator', dir: 'infra-project-creator', requiresEnv: false },
  dns:      { target: process.env.SERVICE_DNS        || 'http://127.0.0.1:3400', port: 3400, name: 'infra-domain-manager', dir: 'infra-domain-manager', requiresEnv: true },
  design:   { target: process.env.SERVICE_DESIGN     || 'http://127.0.0.1:3500', port: 3500, name: 'api-design-assets', dir: 'api-design-assets', requiresEnv: false },
  rag:      { target: process.env.SERVICE_RAG        || 'http://127.0.0.1:3600', port: 3600, name: 'api-conocimiento-rag', dir: 'api-conocimiento-rag', requiresEnv: false },
  scrape:   { target: process.env.SERVICE_SCRAPE     || 'http://127.0.0.1:3700', port: 3700, name: 'api-utilidades-scraping', dir: 'api-utilidades-scraping', requiresEnv: false },
};

const VALID_SERVICES = [
  'infra-github', 'infra-firebase', 'infra-project-creator',
  'infra-domain-manager', 'api-design-assets', 'api-conocimiento-rag',
  'api-utilidades-scraping', 'infra-gateway'
];

// ─── Auto-Wakeup JIT (Arranque bajo demanda de microservicios hijos) ────────
const serviceWarmUntil = new Map();
const inflightWakeups = new Map();

function checkTcpOpen(port, host = '127.0.0.1', timeoutMs = 200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function waitUntilServiceReady(targetUrl, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 350);
      const res = await fetch(`${targetUrl}/ping`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // Reintentar
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function ensureChildServiceAwake(svc) {
  const now = Date.now();
  if ((serviceWarmUntil.get(svc.name) || 0) > now) {
    return true;
  }

  const targetUrlObj = new URL(svc.target);
  const targetPort = Number(targetUrlObj.port) || svc.port;
  const targetHost = targetUrlObj.hostname || '127.0.0.1';

  const isListening = await checkTcpOpen(targetPort, targetHost);
  if (isListening) {
    serviceWarmUntil.set(svc.name, Date.now() + 3000);
    return true;
  }

  if (!AUTO_WAKEUP_ENABLED) {
    return false;
  }

  if (inflightWakeups.has(svc.name)) {
    return inflightWakeups.get(svc.name);
  }

  const wakeupPromise = (async () => {
    console.log(`[AUTO-WAKEUP] Despertando bajo demanda a "${svc.name}" (puerto ${targetPort})...`);
    await runServiceCommand('start', svc.name);
    const ready = await waitUntilServiceReady(svc.target, 5000);
    if (ready) {
      serviceWarmUntil.set(svc.name, Date.now() + 5000);
      console.log(`[AUTO-WAKEUP] "${svc.name}" listo y en línea.`);
    } else {
      console.error(`[AUTO-WAKEUP] Tiempo agotado esperando a "${svc.name}".`);
    }
    return ready;
  })().finally(() => {
    inflightWakeups.delete(svc.name);
  });

  inflightWakeups.set(svc.name, wakeupPromise);
  return wakeupPromise;
}

// ─── Middleware global ──────────────────────────────────────────────────────
app.use(localSecurityMiddleware);
app.use(cors(createLocalCorsOptions()));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => {
  recordActivity(req.url);
  if (!req.url.startsWith('/api/gateway/logs')) {
    console.log(`[GW REQUEST] ${req.method} ${req.url}`);
  }
  next();
});

// ─── Health Check — Estado y telemetría RAM de todos los servicios ──────────
app.get('/api/health', async (_req, res) => {
  const results = {};

  const checks = Object.entries(SERVICES).map(async ([key, svc]) => {
    const envPath = path.resolve(__dirname, '..', svc.dir, '.env');
    const envExists = svc.requiresEnv ? fs.existsSync(envPath) : true;

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      const response = await fetch(`${svc.target}/ping`, { signal: controller.signal });
      clearTimeout(timeout);
      const latency = Date.now() - start;

      let pingPayload = null;
      try {
        pingPayload = await response.json();
      } catch {
        // Ignorar si /ping no devuelve JSON
      }

      const isOnline = response.ok || response.status < 500;
      if (isOnline) {
        serviceWarmUntil.set(svc.name, Date.now() + 3000);
      } else {
        serviceWarmUntil.delete(svc.name);
      }

      results[key] = {
        name: svc.name,
        url: svc.target,
        status: isOnline ? 'online' : 'degraded',
        httpCode: response.status,
        latencyMs: latency,
        memoryMB: typeof pingPayload?.memoryMB === 'number' ? pingPayload.memoryMB : null,
        uptimeSeconds: typeof pingPayload?.uptimeSeconds === 'number' ? pingPayload.uptimeSeconds : null,
        envExists
      };
    } catch {
      serviceWarmUntil.delete(svc.name);
      results[key] = {
        name: svc.name,
        url: svc.target,
        status: 'offline',
        httpCode: null,
        latencyMs: null,
        memoryMB: null,
        uptimeSeconds: null,
        envExists
      };
    }
  });

  await Promise.all(checks);

  const allOnline = Object.values(results).every((r) => r.status === 'online');
  const anyOnline = Object.values(results).some((r) => r.status === 'online');
  const orchestrator = process.env.pm_id !== undefined ? 'pm2' : 'standalone';
  const idleMinutes = Math.floor((Date.now() - lastActivityTimestamp) / 60000);
  const { memoryMB: gatewayMemoryMB, uptimeSeconds } = getProcessMetrics();

  const childrenMemoryMB = Object.values(results).reduce(
    (acc, svc) => acc + (typeof svc.memoryMB === 'number' ? svc.memoryMB : 0),
    0
  );
  const totalSuiteMemoryMB = Number((gatewayMemoryMB + childrenMemoryMB).toFixed(1));

  res.json({
    ok: true,
    data: {
      gateway: 'online',
      overallStatus: allOnline ? 'healthy' : anyOnline ? 'degraded' : 'standby',
      autoWakeup: AUTO_WAKEUP_ENABLED,
      services: results,
      orchestrator,
      idleMinutes,
      idleTimeoutMinutes: IDLE_TIMEOUT_MIN,
      gatewayMemoryMB,
      totalSuiteMemoryMB,
      uptimeSeconds,
      timestamp: new Date().toISOString()
    },
    message: allOnline
      ? 'Todos los servicios están operativos.'
      : AUTO_WAKEUP_ENABLED
        ? 'Gateway activo en modo Auto-Wakeup JIT (los servicios detenidos despertarán bajo demanda).'
        : 'Algunos servicios no están disponibles.'
  });
});

// ─── Información del Gateway ────────────────────────────────────────────────
app.get('/api/gateway/info', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA — API Gateway',
      version: '1.2.0',
      port: PORT,
      autoWakeup: AUTO_WAKEUP_ENABLED,
      routes: Object.entries(SERVICES).map(([prefix, svc]) => ({
        path: `/api/${prefix}/*`,
        target: svc.target,
        service: svc.name
      })),
      healthCheck: '/api/health'
    },
    message: 'Gateway operativo. Usa /api/health para ver el estado de todos los servicios.'
  });
});

/**
 * Construye la instantánea de logs usando lectura eficiente de cola (últimos 64 KB).
 */
function buildLogsSnapshot(service) {
  if (service === 'all') {
    const combined = [];
    for (const svcName of VALID_SERVICES) {
      const file = path.join(LOG_DIR, `${svcName}.log`);
      const tail = readLogTail(file, 40, 32768);
      if (tail && tail.trim()) {
        combined.push(`=== [${svcName.toUpperCase()}] ===\n${tail}`);
      }
    }
    return combined.length > 0 ? combined.join('\n\n') : '[RUNNER] Sin registros de logs activos.';
  }

  const logFile = path.join(LOG_DIR, `${service}.log`);
  const tail = readLogTail(logFile, 250, 65536);
  if (tail === null) {
    return `[RUNNER] No se encontraron archivos de logs para el servicio ${service}.`;
  }
  return tail || `[RUNNER] Archivo de log de ${service} vacío.`;
}

/**
 * Calcula una firma rápida de tamaño y fecha de modificación de los logs relevantes.
 */
function getLogsSignature(service) {
  const targets = service === 'all' ? VALID_SERVICES : [service];
  return targets
    .map((svcName) => {
      const file = path.join(LOG_DIR, `${svcName}.log`);
      try {
        const st = fs.statSync(file);
        return `${svcName}:${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch {
        return `${svcName}:0:0`;
      }
    })
    .join('|');
}

// ─── Streaming SSE en tiempo real de logs ───────────────────────────────────
app.get('/api/gateway/logs/:service/stream', (req, res) => {
  const { service } = req.params;
  if (service !== 'all' && !VALID_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  let lastSig = '';
  const pushIfChanged = () => {
    try {
      const sig = getLogsSignature(service);
      if (sig !== lastSig) {
        lastSig = sig;
        const logs = buildLogsSnapshot(service);
        res.write(`data: ${JSON.stringify({ ok: true, logs })}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ ok: false, message: err.message })}\n\n`);
    }
  };

  pushIfChanged();
  const interval = setInterval(pushIfChanged, 1500);
  interval.unref?.();

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ─── Endpoint HTTP clásico de logs de servicios (individual o 'all') ────────
app.get('/api/gateway/logs/:service', (req, res) => {
  const { service } = req.params;
  if (service !== 'all' && !VALID_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  try {
    const logs = buildLogsSnapshot(service);
    return res.json({ ok: true, logs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'READ_ERROR', message: `Error al leer logs: ${err.message}` });
  }
});

// ─── Limpiar archivos de logs de servicios (individual o 'all') ─────────────
app.delete('/api/gateway/logs/:service', (req, res) => {
  const { service } = req.params;

  try {
    if (service === 'all') {
      for (const svcName of VALID_SERVICES) {
        const file = path.join(LOG_DIR, `${svcName}.log`);
        if (fs.existsSync(file)) {
          fs.writeFileSync(file, '', 'utf-8');
        }
      }
      return res.json({ ok: true, message: 'Todos los archivos de logs han sido vaciados.' });
    }

    if (!VALID_SERVICES.includes(service)) {
      return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
    }

    const logFile = path.join(LOG_DIR, `${service}.log`);
    if (fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, '', 'utf-8');
    }
    return res.json({ ok: true, message: `Archivo de log de ${service} vaciado.` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'CLEAR_ERROR', message: err.message });
  }
});

// ─── Endpoints de Control de Servicios (Start/Stop/Restart individual o 'all') ─
app.post('/api/gateway/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;

  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return res.status(400).json({ ok: false, error: 'INVALID_ACTION', message: 'Acción no válida. Usar start, stop o restart.' });
  }

  if (service === 'all') {
    serviceWarmUntil.clear();
    if (action === 'start') {
      const result = await runServiceCommand('start', 'all');
      return res.status(result.ok ? 200 : 500).json({
        ok: result.ok,
        message: 'Todos los microservicios han sido iniciados.',
        output: result.output
      });
    } else if (action === 'restart') {
      const childServices = VALID_SERVICES.filter((s) => s !== 'infra-gateway');
      await Promise.all(childServices.map((svc) => runServiceCommand('stop', svc)));
      const result = await runServiceCommand('start', 'all');
      return res.status(result.ok ? 200 : 500).json({
        ok: result.ok,
        message: 'Todos los microservicios de negocio han sido reiniciados.',
        output: result.output
      });
    } else {
      const childServices = VALID_SERVICES.filter((s) => s !== 'infra-gateway');
      await Promise.all(childServices.map((svc) => runServiceCommand('stop', svc)));
      return res.json({
        ok: true,
        message: 'Todos los microservicios de negocio han sido detenidos (Gateway en línea).'
      });
    }
  }

  if (!VALID_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  serviceWarmUntil.delete(service);
  const result = await runServiceCommand(action, service);
  if (result.ok) {
    res.json({ ok: true, message: `Acción '${action}' ejecutada correctamente para ${service}.`, output: result.output });
  } else {
    res.status(500).json({ ok: false, error: 'ACTION_FAILED', message: `No se pudo realizar la acción '${action}' para ${service}.`, details: result.output || result.error });
  }
});

// ─── Ruta raíz — Fallback si no se carga index.html ─────────────────────────
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA — API Gateway',
      version: '1.2.0',
      status: 'online',
      dashboard: 'active',
      autoWakeup: AUTO_WAKEUP_ENABLED
    },
    message: 'Gateway operativo. Dashboard activo.'
  });
});

// ─── Proxy Middleware con Auto-Wakeup JIT ───────────────────────────────────
for (const [prefix, svc] of Object.entries(SERVICES)) {
  const proxy = createProxyMiddleware({
    target: svc.target,
    changeOrigin: true,
    pathRewrite: {
      [`^/api/${prefix}/`]: '/',
      [`^/api/${prefix}$`]: ''
    },
    on: {
      error: (_err, _req, res) => {
        serviceWarmUntil.delete(svc.name);
        if (!res.headersSent) {
          res.status(503).json({
            ok: false,
            error: 'SERVICE_UNAVAILABLE',
            message: `El servicio "${svc.name}" no está disponible en ${svc.target}.`
          });
        }
      }
    }
  });

  app.use(`/api/${prefix}`, async (req, res, next) => {
    const awake = await ensureChildServiceAwake(svc);
    if (!awake) {
      return res.status(503).json({
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: `El servicio "${svc.name}" está apagado y no pudo despertarse automáticamente en ${svc.target}.`
      });
    }
    return proxy(req, res, next);
  });
}

// ─── Control del Gateway ────────────────────────────────────────────────────
app.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'infra-gateway',
    port: PORT,
    ...getProcessMetrics()
  });
});

// ─── Manejador de errores CORS / Seguridad ──────────────────────────────────
app.use((err, _req, res, next) => {
  if (err && err.status === 403) {
    return res.status(403).json({ ok: false, error: 'CORS_BLOCKED', message: err.message });
  }
  return next(err);
});

let serverInstance = null;

app.post('/api/gateway/shutdown', (_req, res) => {
  res.json({ success: true, message: 'API Gateway apagándose...' });
  console.log('Recibida petición de apagado. Cerrando API Gateway...');
  setTimeout(() => {
    if (serverInstance) {
      serverInstance.close(() => process.exit(0));
    }
    setTimeout(() => process.exit(0), 400).unref();
  }, 300);
});

// ─── Ruta 404 para peticiones no mapeadas ───────────────────────────────────
app.use((_req, res) => {
  const availableRoutes = Object.keys(SERVICES).map((k) => `/api/${k}/*`).join(', ');
  res.status(404).json({
    ok: false,
    error: 'ROUTE_NOT_FOUND',
    message: `Ruta no encontrada. Rutas disponibles: ${availableRoutes}, /api/health`
  });
});

// ─── Arranque restringido a loopback 127.0.0.1 ─────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  serverInstance = app.listen(PORT, LOCAL_HOST, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       GATEWAY — Proyectos IA — API Central (ARM64)       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Host Seguro:   http://${LOCAL_HOST}:${PORT}                    ║`);
    console.log(`║  Health Check:  http://localhost:${PORT}/api/health        ║`);
    console.log(`║  Auto-Wakeup:   ${AUTO_WAKEUP_ENABLED ? 'ACTIVO (JIT bajo demanda)' : 'DESACTIVADO'}             ║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    for (const [prefix, svc] of Object.entries(SERVICES)) {
      const pad = `  /api/${prefix}/*`.padEnd(20);
      console.log(`║${pad}→ ${svc.target.padEnd(30)}(${svc.name}) ║`);
    }
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

export { app, buildLogsSnapshot };
