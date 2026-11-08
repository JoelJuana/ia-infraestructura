# api-utilidades-scraping

Microservicio encargado del raspado y extracción limpia de texto estructurado desde URLs web públicas en formato Markdown, libre de ruido visual, anuncios o código.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3700` (Gateway: `/api/scrape`)
- **Ruta física**: `IA_Infraestructura/api-utilidades-scraping/`
- **Requiere variables de entorno (.env)**: No

## ⚙️ Funciones Clave

1. **Extracción Web No Intrusiva**: Convierte el árbol DOM de páginas HTML directamente a texto Markdown optimizado para el procesamiento por parte de agentes de IA.
2. **Eliminación de Ruido (Sanitización)**: Remueve de forma automática bloques de navegación, pie de página, scripts de analytics, CSS embebido y elementos de anuncios publicitarios.
3. **Mecanismo de Caché Temporal**: Reduce peticiones consecutivas al mismo dominio para respetar las políticas de tasa de consumo.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/scrape` | Extrae y procesa el contenido textual de una URL web y lo retorna en Markdown |
| `GET` | `/ping` | Healthcheck del servicio |
| `POST` | `/api/shutdown` | Cierre limpio del servidor |
