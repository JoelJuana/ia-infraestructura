# infra-project-creator

Backend de la herramienta visual para la creación, renombrado y borrado estructurado de nuevos proyectos en el monorepositorio local `IA_Proyectos`.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3300` (Gateway: `/api/proj`)
- **Ruta física**: `IA_Infraestructura/infra-project-creator/`
- **Requiere variables de entorno (.env)**: Sí
  - `BASE_PROYECTOS_DIR`: Ruta absoluta local al directorio del monorepositorio (ej. `C:\Users\jjtei\Desktop\IA_Proyectos\`).

## ⚙️ Funciones Clave

1. **Scaffolding Multi-Tecnología**: Genera plantillas base limpias para diferentes tipos de proyectos:
   - `vanilla`: HTML, CSS y JS básico.
   - `react`: React clásico con Vite.
   - `node` / `api`: Aplicación Node.js básica con Express y CORS configurados.
   - `python`: Crea un entorno virtual (`venv`) con scripts básicos.
2. **Ciclo de Vida Integrado y Publicación Automática ("Zero-Touch Docs")**:
   - Enruta automáticamente aplicaciones generales a `apps/<nombre>` y simuladores financieros (`app-bp-*`) a `apps/business-plans/<nombre>`.
   - Inicializa/sincroniza el repositorio Git del monorepositorio, crea commit y empuja a `main`.
   - Registra de forma automática la nueva aplicación en `projects.json`.
   - Crea automáticamente subdominios CNAME en Cloudflare mediante `dnsService`.
   - Crea un Issue de inicio en GitHub.
   - Dispara en segundo plano `auto-publish.js` en `IA_Documentacion` al crear, renombrar o eliminar proyectos para publicar la ficha en `https://antigravity.gironacc.com` e indexarla en el RAG.
3. **Ejecución Asíncrona (Jobs)**:
   - Las operaciones pesadas (como instalaciones de npm y compilación inicial) se ejecutan asíncronamente en segundo plano.
   - Retorna un `jobId` que permite monitorizar el estado del scaffolding.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/diagnose` | Diagnóstico de herramientas del sistema (node, git, npm, python) |
| `GET` | `/api/projects` | Lista todos los proyectos registrados en `projects.json` |
| `POST` | `/api/projects/create` | Crea un nuevo proyecto (asíncrono, retorna `jobId`) |
| `GET` | `/api/status` | Obtiene el estado y logs de un job mediante `?jobId=...` |
| `DELETE` | `/api/projects/:name` | Elimina un proyecto (archivos, registro json, Git e IP DNS) |
| `POST` | `/api/projects/rename` | Renombra una carpeta y actualiza todas las referencias del proyecto |
| `POST` | `/api/shutdown` | Apaga de forma limpia el servidor del Project Creator |
| `GET` | `/ping` | Healthcheck del servicio |
