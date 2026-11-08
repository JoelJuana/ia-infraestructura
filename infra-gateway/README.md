# infra-gateway

API Gateway centralizador y Dashboard de observabilidad para la suite de agentes locales de `IA_Infraestructura`.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3000`
- **Ruta física**: `IA_Infraestructura/infra-gateway/`
- **Rutas Gateway**: `/` (Dashboard) y `/api/*` (Proxies de Microservicios)
- **Requiere variables de entorno (.env)**: No

## ⚙️ Funciones y Características

1. **Proxy Reverso Central**: Enruta dinámicamente todo el tráfico hacia las APIs internas correspondientes según los prefijos:
   - `/api/git/*` -> `infra-github` (:3100)
   - `/api/fb/*` -> `infra-firebase` (:3200)
   - `/api/proj/*` -> `infra-project-creator` (:3300)
   - `/api/dns/*` -> `infra-domain-manager` (:3400)
   - `/api/design/*` -> `api-design-assets` (:3500)
   - `/api/rag/*` -> `api-conocimiento-rag` (:3600)
   - `/api/scrape/*` -> `api-utilidades-scraping` (:3700)
2. **Dashboard de Control Visual**: Interfaz interactiva en `http://localhost:3000` con:
   - Monitorización del estado de salud de todos los microservicios en vivo.
   - Visor de logs en caliente (últimas 250 líneas) de cada servicio.
   - Acciones directas para Iniciar (`start`) o Detener (`stop`) servicios de forma individual.
3. **Auditoría de Entorno**: Verifica de manera proactiva la presencia del archivo `.env` en los servicios que lo requieren.
4. **Apagado Ordenado**: Endpoint `/api/gateway/shutdown` para detener los microservicios y el gateway de forma controlada.

## 📡 Endpoints de Control

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Diagnóstico de salud de toda la suite (latencia, estado, entorno) |
| `GET` | `/api/gateway/info` | Rutas mapeadas y puertos del Gateway |
| `GET` | `/api/gateway/logs/:service` | Recupera las últimas 250 líneas del log del servicio indicado |
| `POST` | `/api/gateway/services/:service/:action` | Ejecuta acciones de control (`start` / `stop`) sobre un servicio |
| `POST` | `/api/gateway/shutdown` | Apaga de forma limpia el Gateway |
| `GET` | `/ping` | Healthcheck del Gateway |
