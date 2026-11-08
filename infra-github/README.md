# infra-github

Microservicio para gestionar automatizaciones Git de forma local y remota mediante GitHub API (Octokit) y Git local. Sirve como backend del GitPublish CMS.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3100` (Gateway: `/api/git`)
- **Ruta física**: `IA_Infraestructura/infra-github/`
- **Requiere variables de entorno (.env)**: Sí
  - `GITHUB_TOKEN`: Token de acceso personal con permisos en repositorios.
  - `GITHUB_OWNER`: Usuario u organización propietaria del repositorio.
  - `GITHUB_REPO`: Nombre del repositorio remoto a gestionar.
  - `GITHUB_BRANCH`: Rama por defecto (ej. `main`).
  - `GITHUB_POSTS_PATH`: Ruta dentro del repo donde se guardan los Markdown (ej. `posts`).

## ⚙️ Funciones Clave

1. **Gestión Remota (GitHub API)**:
   - Control total de repositorios, ramas, Issues y Pull Requests.
   - Guardado, actualización y borrado de posts Markdown con validación Frontmatter obligatoria.
   - Workflow automatizado en un paso: crea rama -> commitea archivo -> crea PR -> mergea PR -> elimina rama.
2. **Control de Versiones Local (Git CLI)**:
   - Permite consultar logs, diffs de commits y el estado del working tree local.
   - Ejecuta `git init`, `git add`, `git commit` y reseteo de cambios locales.

## 📡 Endpoints Mapeados

### API Remota (GitHub)

| Método | Ruta | Descripción |
|---|---|---|
| `GET`/`POST` | `/api/config` | Obtener o guardar variables de configuración |
| `GET` | `/api/repos` | Listar repositorios del usuario |
| `POST` | `/api/repos` | Crear un repositorio remoto |
| `GET` | `/api/branches` | Listar ramas |
| `POST` | `/api/branches` | Crear una nueva rama desde otra existente |
| `DELETE` | `/api/branches/:name` | Eliminar rama |
| `GET` | `/api/pulls` | Listar Pull Requests con estado de CI |
| `POST` | `/api/pulls` | Crear un Pull Request |
| `POST` | `/api/pulls/:number/merge` | Merge de un Pull Request |
| `GET` | `/api/issues` | Listar Issues abiertas |
| `POST` | `/api/issues` | Crear un Issue |
| `POST` | `/api/issues/:number/close` | Cerrar un Issue |
| `GET` | `/api/posts` | Listar archivos Markdown en la ruta configurada |
| `GET` | `/api/posts/:filename` | Leer el contenido de un post |
| `POST` | `/api/posts` | Guardar o actualizar un post Markdown (con Frontmatter) |
| `DELETE` | `/api/posts/:filename` | Eliminar un post |
| `POST` | `/api/media` | Subir archivos/recursos (base64) |
| `GET` | `/api/commits` | Listar los últimos commits remotos |
| `POST` | `/api/workflow` | Ejecutar el workflow automatizado completo |

### API Local (Git)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/local/status/:project` | `git status` del proyecto |
| `POST` | `/local/init/:project` | `git init` + primer commit local |
| `GET` | `/local/log/:project` | Últimos 20 commits locales |
| `GET` | `/local/diff/:project/:hash` | Diff de un commit específico o working tree |
| `POST` | `/local/revert/:project` | Revierte cambios locales (hard reset o revert) |
| `POST` | `/local/commit/:project` | Añade todo y realiza commit local |
