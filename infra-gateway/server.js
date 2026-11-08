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
function runServiceCommand(action, serviceName) {
  return new Promise((resolve) => {
    const runnerPath = path.resolve(__dirname, '..', 'scripts', 'infra-runner.js');
    exec(`node "${runnerPath}" ${action} ${serviceName}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error al ejecutar runner (${action} ${serviceName}):`, error);
        resolve({ ok: false, error: error.message, output: stderr || stdout });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

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

// ─── Middleware global ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // Servir interfaz estática (Dashboard)
app.use((req, res, next) => {
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
      const timeout = setTimeout(() => controller.abort(), 2000);
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

  const allOnline = Object.values(results).every(r => r.status === 'online');
  const anyOnline = Object.values(results).some(r => r.status === 'online');
  const orchestrator = process.env.pm_id !== undefined ? 'pm2' : 'standalone';

  res.json({
    ok: true,
    data: {
      gateway: 'online',
      overallStatus: allOnline ? 'healthy' : anyOnline ? 'degraded' : 'critical',
      services: results,
      orchestrator,
      timestamp: new Date().toISOString()
    },
    message: allOnline
      ? 'Todos los servicios están operativos.'
      : `Algunos servicios no están disponibles.`
  });
});

// ─── Información del Gateway ────────────────────────────────────────────────
app.get('/api/gateway/info', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA — API Gateway',
      version: '1.0.0',
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

// ─── Endpoint de logs de servicios ──────────────────────────────────────────
app.get('/api/gateway/logs/:service', (req, res) => {
  const { service } = req.params;
  const validServices = [
    'infra-github', 'infra-firebase', 'infra-project-creator', 
    'infra-domain-manager', 'api-design-assets', 'api-conocimiento-rag', 
    'api-utilidades-scraping', 'infra-gateway'
  ];

  if (!validServices.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  const logFile = path.resolve(__dirname, '..', '.infra-logs', `${service}.log`);

  if (!fs.existsSync(logFile)) {
    return res.json({ ok: true, logs: `[RUNNER] No se encontraron archivos de logs para el servicio ${service}.` });
  }

  try {
    const data = fs.readFileSync(logFile, 'utf-8');
    const lines = data.split('\n');
    const lastLines = lines.slice(-250).join('\n'); // Devolver las últimas 250 líneas
    res.json({ ok: true, logs: lastLines });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'READ_ERROR', message: `Error al leer logs: ${err.message}` });
  }
});

// ─── Endpoints de Control de Servicios (Start/Stop) ─────────────────────────
app.post('/api/gateway/services/:service/:action', async (req, res) => {
  const { service, action } = req.params;
  const validServices = [
    'infra-github', 'infra-firebase', 'infra-project-creator', 
    'infra-domain-manager', 'api-design-assets', 'api-conocimiento-rag', 
    'api-utilidades-scraping', 'infra-gateway'
  ];

  if (!validServices.includes(service)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SERVICE', message: 'Servicio no válido.' });
  }

  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ ok: false, error: 'INVALID_ACTION', message: 'Acción no válida. Usar start o stop.' });
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
      version: '1.0.0',
      status: 'online',
      dashboard: 'active'
    },
    message: 'Gateway operativo. Dashboard activo. Si no se visualiza la interfaz, comprueba que exista la carpeta public/ y sus archivos.'
  });
});

// ─── Proxy Middleware — Redirección a microservicios ────────────────────────
// Cada prefijo /api/<key>/* se redirige al servicio correspondiente.
// El prefijo /api/<key> se elimina antes de reenviar al servicio destino.

for (const [prefix, svc] of Object.entries(SERVICES)) {
  app.use(
    `/api/${prefix}`,
    createProxyMiddleware({
      target: svc.target,
      changeOrigin: true,
      pathRewrite: {
        [`^/api/${prefix}/`]: '/',  // Reemplaza /api/prefijo/ por /
        [`^/api/${prefix}$`]: '',   // Reemplaza /api/prefijo al final por vacio
      },
      on: {
        error: (err, _req, res) => {
          if (!res.headersSent) {
            res.status(503).json({
              ok: false,
              error: 'SERVICE_UNAVAILABLE',
              message: `El servicio "${svc.name}" no está disponible en ${svc.target}. Arráncalo con "npm run start" o manualmente.`
            });
          }
        }
      }
    })
  );
}

// ─── Control del Gateway ────────────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/gateway/shutdown', (req, res) => {
  res.json({ success: true, message: 'API Gateway apagándose...' });
  console.log('Recibida petición de apagado. Cerrando API Gateway...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// ─── Ruta 404 para peticiones no mapeadas ───────────────────────────────────
app.use((_req, res) => {
  const availableRoutes = Object.keys(SERVICES).map(k => `/api/${k}/*`).join(', ');
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
