import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper para ejecutar comandos en el runner de forma asíncrona
function runServiceCommand(action, serviceName = '') {
  return new Promise((resolve) => {
    const runnerPath = path.resolve(__dirname, '..', 'scripts', 'infra-runner.js');
    const arg = serviceName ? ` ${serviceName}` : '';
    exec(`node "${runnerPath}" ${action}${arg}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error al ejecutar runner (${action}${arg}):`, error);
        resolve({ ok: false, error: error.message, output: stderr || stdout });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Watchdog de Auto-Apagado por Inactividad (protección ARM64) ────────────
const IDLE_TIMEOUT_MIN = Number(process.env.GATEWAY_IDLE_TIMEOUT_MIN || 30);
let lastActivityTimestamp = Date.now();

function recordActivity(reqUrl) {
  // No reiniciar el contador por sondeig pasivo del Dashboard
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
  git:      { target: process.env.SERVICE_GITHUB    || 'http://localhost:3100', name: 'infra-github', dir: 'infra-github', requiresEnv: true },
  fb:       { target: process.env.SERVICE_FIREBASE   || 'http://localhost:3200', name: 'infra-firebase', dir: 'infra-firebase', requiresEnv: true },
  proj:     { target: process.env.SERVICE_PROJECTS   || 'http://localhost:3300', name: 'infra-project-creator', dir: 'infra-project-creator', requiresEnv: false },
  dns:      { target: process.env.SERVICE_DNS        || 'http://localhost:3400', name: 'infra-domain-manager', dir: 'infra-domain-manager', requiresEnv: true },
  design:   { target: process.env.SERVICE_DESIGN     || 'http://localhost:3500', name: 'api-design-assets', dir: 'api-design-assets', requiresEnv: false },
  rag:      { target: process.env.SERVICE_RAG        || 'http://localhost:3600', name: 'api-conocimiento-rag', dir: 'api-conocimiento-rag', requiresEnv: false },
  scrape:   { target: process.env.SERVICE_SCRAPE     || 'http://localhost:3700', name: 'api-utilidades-scraping', dir: 'api-utilidades-scraping', requiresEnv: false },
};

const VALID_SERVICES = [
  'infra-github', 'infra-firebase', 'infra-project-creator',
  'infra-domain-manager', 'api-design-assets', 'api-conocimiento-rag',
  'api-utilidades-scraping', 'infra-gateway'
];

// ─── Middleware global ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => {
  recordActivity(req.url);
  console.log(`[GW REQUEST] ${req.method} ${req.url}`);
  next();
});

// ─── Health Check — Estado de todos los servicios ───────────────────────────
app.get('/api/health', async (_req, res) => {
  const results = {};

  const checks = Object.entries(SERVICES).map(async ([key, svc]) => {
    const envPath = path.resolve(__dirname, '..', svc.dir, '.env');
    const envExists = svc.requiresEnv ? fs.existsSync(envPath) : true;

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`${svc.target}/ping`, { signal: controller.signal });
      clearTimeout(timeout);
      const latency = Date.now() - start;
      results[key] = {
        name: svc.name,
        url: svc.target,
        status: response.ok || response.status < 500 ? 'online' : 'degraded',
        httpCode: response.status,
        latencyMs: latency,
        envExists
      };
    } catch {
      results[key] = {
        name: svc.name,
        url: svc.target,
        status: 'offline',
        httpCode: null,
        latencyMs: null,
        envExists
      };
    }
  });

  await Promise.all(checks);

  const allOnline = Object.values(results).every((r) => r.status === 'online');
  const anyOnline = Object.values(results).some((r) => r.status === 'online');
  const orchestrator = process.env.pm_id !== undefined ? 'pm2' : 'standalone';
  const idleMinutes = Math.floor((Date.now() - lastActivityTimestamp) / 60000);

  res.json({
    ok: true,
    data: {
      gateway: 'online',
      overallStatus: allOnline ? 'healthy' : anyOnline ? 'degraded' : 'critical',
      services: results,
      orchestrator,
      idleMinutes,
      idleTimeoutMinutes: IDLE_TIMEOUT_MIN,
      timestamp: new Date().toISOString()
    },
    message: allOnline
      ? 'Todos los servicios están operativos.'
      : 'Algunos servicios no están disponibles.'
  });
});

// ─── Información del Gateway ────────────────────────────────────────────────
app.get('/api/gateway/info', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA — API Gateway',
      version: '1.1.0',
      port: PORT,
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

// ─── Endpoint de logs de servicios (individual o 'all' para Consola Global) ─
app.get('/api/gateway/logs/:service', (req, res) => {
  const { service } = req.params;
  const logDir = path.resolve(__dirname, '..', '.infra-logs');

  if (service === 'all') {
    try {
      const combined = [];
      for (const svcName of VALID_SERVICES) {
        const file = path.join(logDir, `${svcName}.log`);
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8').trim();
          if (content) {
            const tail = content.split('\n').slice(-40).join('\n');
            combined.push(`=== [${svcName.toUpperCase()}] ===\n${tail}`);
          }
        }
      }
      return res.json({
        ok: true,
        logs: combined.length > 0 ? combined.join('\n\n') : '[RUNNER] Sin registros de logs activos.'
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'READ_ERROR', message: err.message });
    }
  }

  if (!VALID_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  const logFile = path.join(logDir, `${service}.log`);

  if (!fs.existsSync(logFile)) {
    return res.json({ ok: true, logs: `[RUNNER] No se encontraron archivos de logs para el servicio ${service}.` });
  }

  try {
    const data = fs.readFileSync(logFile, 'utf-8');
    const lines = data.split('\n');
    const lastLines = lines.slice(-250).join('\n');
    res.json({ ok: true, logs: lastLines });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'READ_ERROR', message: `Error al leer logs: ${err.message}` });
  }
});

// ─── Endpoints de Control de Servicios (Start/Stop individual o 'all') ──────
app.post('/api/gateway/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;

  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ ok: false, error: 'INVALID_ACTION', message: 'Acción no válida. Usar start o stop.' });
  }

  if (service === 'all') {
    if (action === 'start') {
      const result = await runServiceCommand('start', 'all');
      return res.status(result.ok ? 200 : 500).json({
        ok: result.ok,
        message: 'Todos los microservicios han sido iniciados.',
        output: result.output
      });
    } else {
      // Al detener todos desde el Dashboard, detenemos los 7 microservicios hijos manteniendo el Gateway activo
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
      version: '1.1.0',
      status: 'online',
      dashboard: 'active'
    },
    message: 'Gateway operativo. Dashboard activo.'
  });
});

// ─── Proxy Middleware — Redirección a microservicios ────────────────────────
for (const [prefix, svc] of Object.entries(SERVICES)) {
  app.use(
    `/api/${prefix}`,
    createProxyMiddleware({
      target: svc.target,
      changeOrigin: true,
      pathRewrite: {
        [`^/api/${prefix}/`]: '/',
        [`^/api/${prefix}$`]: '',
      },
      on: {
        error: (_err, _req, res) => {
          if (!res.headersSent) {
            res.status(503).json({
              ok: false,
              error: 'SERVICE_UNAVAILABLE',
              message: `El servicio "${svc.name}" no está disponible en ${svc.target}. Arráncalo con "npm run start" o desde el Dashboard.`
            });
          }
        }
      }
    })
  );
}

// ─── Control del Gateway ────────────────────────────────────────────────────
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', service: 'infra-gateway', port: PORT });
});

app.post('/api/gateway/shutdown', (_req, res) => {
  res.json({ success: true, message: 'API Gateway apagándose...' });
  console.log('Recibida petición de apagado. Cerrando API Gateway...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
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

// ─── Arranque ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       🚀 GATEWAY — Proyectos IA — API Central          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Puerto:        http://localhost:${PORT}                   ║`);
  console.log(`║  Health Check:  http://localhost:${PORT}/api/health        ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  for (const [prefix, svc] of Object.entries(SERVICES)) {
    const pad = `  /api/${prefix}/*`.padEnd(20);
    console.log(`║${pad}→ ${svc.target.padEnd(30)}(${svc.name}) ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
