# Gateway — API Central de Proyectos IA

Punto de acceso único (puerto `3000`) para todas las APIs de infraestructura del monorepositorio. Actúa como proxy inverso, redirigiendo el tráfico a los microservicios locales correspondientes.

## Mapa de Rutas

| Ruta Gateway | Servicio Destino | Puerto |
|---|---|---|
| `/api/git/*` | `github` — Automatización de Git y GitHub | `4000` |
| `/api/fb/*` | `firbase` — Automatización de Firebase | `4001` |
| `/api/proj/*` | `crear-proyecto` — Scaffolding de proyectos | `4100` |
| `/api/dns/*` | `gestion-dominios` — DNS y Cloudflare | `4200` |
| `/api/forge/*` | `taskforge` — Orquestador de agentes | `5000` |
| `/api/health` | Health check de todos los servicios | — |

## Contrato de Respuestas JSON

Todas las respuestas del Gateway siguen este formato estándar:

**Éxito:**
```json
{
  "ok": true,
  "data": { ... },
  "message": "Operación completada con éxito"
}
```

**Error:**
```json
{
  "ok": false,
  "error": "SERVICE_UNAVAILABLE",
  "message": "El servicio 'firbase' no está disponible en http://localhost:4001."
}
```

## Comandos

```bash
# Instalar dependencias
npm install

# Arrancar en modo desarrollo (con auto-reload)
npm run dev

# Arrancar en modo producción
npm start
```

## Health Check

```bash
curl http://localhost:3000/api/health
```

Devuelve el estado (online/offline) de cada microservicio del ecosistema.

## Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto (ver `.env` de ejemplo):

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto del Gateway | `3000` |
| `SERVICE_GITHUB` | URL del servicio de Git | `http://localhost:4000` |
| `SERVICE_FIREBASE` | URL del servicio de Firebase | `http://localhost:4001` |
| `SERVICE_PROJECTS` | URL del servicio de creación de proyectos | `http://localhost:4100` |
| `SERVICE_DNS` | URL del servicio de DNS/Cloudflare | `http://localhost:4200` |
| `SERVICE_TASKFORGE` | URL del backend de TaskForge | `http://localhost:5000` |
