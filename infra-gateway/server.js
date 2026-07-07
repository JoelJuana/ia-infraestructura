import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Configuración de servicios ─────────────────────────────────────────────
const SERVICES = {
  git:      { target: process.env.SERVICE_GITHUB    || 'http://localhost:3100', name: 'infra-github' },
  fb:       { target: process.env.SERVICE_FIREBASE   || 'http://localhost:3200', name: 'infra-firebase' },
  proj:     { target: process.env.SERVICE_PROJECTS   || 'http://localhost:3300', name: 'infra-project-creator' },
  dns:      { target: process.env.SERVICE_DNS        || 'http://localhost:3400', name: 'infra-domain-manager' },
  design:   { target: process.env.SERVICE_DESIGN     || 'http://localhost:3500', name: 'api-design-assets' },
  rag:      { target: process.env.SERVICE_RAG        || 'http://localhost:3600', name: 'api-conocimiento-rag' },
  scrape:   { target: process.env.SERVICE_SCRAPE     || 'http://localhost:3700', name: 'api-utilidades-scraping' },
};

// ─── Middleware global ──────────────────────────────────────────────────────
app.use(cors());
app.use((req, res, next) => {
  console.log(`[GW REQUEST] ${req.method} ${req.url}`);
  next();
});

// ─── Health Check — Estado de todos los servicios ───────────────────────────
app.get('/api/health', async (_req, res) => {
  const results = {};

  const checks = Object.entries(SERVICES).map(async ([key, svc]) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${svc.target}/`, { signal: controller.signal });
      clearTimeout(timeout);
      results[key] = {
        name: svc.name,
        url: svc.target,
        status: response.ok || response.status < 500 ? 'online' : 'degraded',
        httpCode: response.status
      };
    } catch {
      results[key] = {
        name: svc.name,
        url: svc.target,
        status: 'offline',
        httpCode: null
      };
    }
  });

  await Promise.all(checks);

  const allOnline = Object.values(results).every(r => r.status === 'online');
  const anyOnline = Object.values(results).some(r => r.status === 'online');

  res.json({
    ok: true,
    data: {
      gateway: 'online',
      overallStatus: allOnline ? 'healthy' : anyOnline ? 'degraded' : 'critical',
      services: results,
      timestamp: new Date().toISOString()
    },
    message: allOnline
      ? 'Todos los servicios están operativos.'
      : `Algunos servicios no están disponibles.`
  });
});

// ─── Información del Gateway ────────────────────────────────────────────────
app.get('/', (_req, res) => {
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
              message: `El servicio "${svc.name}" no está disponible en ${svc.target}. Arráncalo con start-infra.ps1 o manualmente.`
            });
          }
        }
      }
    })
  );
}

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
