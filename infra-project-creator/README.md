# Project Creator — API Local de Scaffolding y Automatización

Este servicio proporciona una **API local robusta y panel interactivo** para automatizar el scaffolding, la inicialización y el registro de nuevos proyectos estructurados dentro del monorepositorio **Proyectos IA**. Está optimizado para ser consumido tanto por desarrolladores como por agentes autónomos de nuestra suite.

## Características Principales
- **Arquitectura Limpia con Express**: API modular estructurada en servicios (`scaffolderService`, `gitService`, `dnsService`).
- **Motor de Plantillas Dinámico**: Copia recursivamente estructuras base desde el directorio global `_plantillas/` de la raíz y reemplaza dinámicamente placeholders en los archivos (`{{PROJECT_NAME}}`, `{{nameClean}}`, `{{PROJECT_DESCRIPTION}}`, `{{AUTHOR}}`, etc.).
- **Catálogo Automatizado**: Registra automáticamente cada nuevo proyecto en el catálogo central `projects.json`.
- **Integración DNS (Cloudflare)**: Se comunica con la API local de `gestion-dominios` para configurar y actualizar registros CNAME de forma dinámica en Cloudflare.
- **Automatización Git/GitHub**: Inicializa repositorios, crea Issues de bienvenida con tareas iniciales en GitHub, realiza commits convencionales y empuja los cambios al repositorio remoto (`proyectos_ia` de GitHub).
- **Seguridad Integrada**: Prevención de ataques de *Path Traversal* validando nombres de proyectos mediante expresiones regulares seguras.

---

## Cómo Levantar el Servicio

1. Asegúrate de tener configuradas tus variables de entorno en el archivo `.env` del directorio:
   ```env
   PORT=4100
   BASE_PROYECTOS_DIR=C:\Users\jjtei\Desktop\Proyectos_IA
   ```
2. Instala las dependencias necesarias:
   ```bash
   npm install
   ```
3. Levanta el servidor en modo producción:
   ```bash
   npm start
   ```
   O levántalo en modo desarrollo con recarga automática:
   ```bash
   npm run dev
   ```

El servidor estará activo y escuchando en `http://localhost:4100`.

---

## Documentación de la API para Agentes Autónomos

### 1. Health Check
* **Endpoint**: `GET /ping`
* **Descripción**: Verifica que la API local esté levantada y responda correctamente.
* **Respuesta (200 OK)**:
  ```json
  {
    "status": "ok"
  }
  ```

### 2. Diagnóstico del Entorno
* **Endpoint**: `GET /api/diagnose`
* **Descripción**: Valida si las herramientas clave del sistema (`Node.js`, `Git` y `Python`) están instaladas y disponibles en el PATH.
* **Respuesta (200 OK)**:
  ```json
  {
    "node": true,
    "git": true,
    "python": true
  }
  ```

### 3. Crear Proyecto (Scaffolding)
* **Endpoint**: `POST /api/projects/create`
* **Descripción**: Inicializa la estructura del proyecto en la raíz del monorepositorio copiando la plantilla correspondiente de `_plantillas/`, reemplaza placeholders, registra el proyecto en `projects.json`, crea el CNAME en Cloudflare, crea un Issue de GitHub y sincroniza mediante Git commit y push.
* **Payload JSON requerido**:
  ```json
  {
    "name": "nombre-del-proyecto",
    "type": "vanilla | node | react | api | python",
    "description": "Una breve descripción del propósito del proyecto",
    "author": "JoelJuana",
    "extras": ["gitignore", "changelog", "license", "chartjs"],
    "customDependencies": ["axios", "lodash"]
  }
  ```
  *(Nota: `extras` y `customDependencies` son opcionales. Por defecto se inicializan con gitignore y changelog).*
* **Respuesta (200 OK)**:
  ```json
  {
    "jobId": "1719748956321",
    "message": "Proceso de creación de proyecto iniciado."
  }
  ```
  *(El proceso corre de forma asíncrona en segundo plano para evitar bloquear la llamada HTTP. Puedes consultar el progreso usando el endpoint `/api/status?jobId=<jobId>`).*

### 4. Consultar Estado de Creación (Logs)
* **Endpoint**: `GET /api/status`
* **Descripción**: Recupera el estado y el historial detallado de logs de ejecución de la terminal local para un `jobId` de creación.
* **Parámetros URL**: `jobId` (requerido).
* **Respuesta (200 OK)**:
  ```json
  {
    "status": "completed | running | failed",
    "logs": [
      "[14:06:50] Iniciando creación del proyecto: \"mi-app\" (node)",
      "[14:06:51] Copiando plantilla desde _plantillas/node ...",
      "[14:06:51] Estructura base copiada con éxito.",
      "[14:06:52] Instalando dependencias npm en el nuevo proyecto...",
      "[14:06:55] ✓ Comando completado con éxito.",
      "[14:06:56] ✓ Proyecto registrado en projects.json central.",
      "[14:06:56] ✓ Proceso de creación y automatización de \"mi-app\" finalizado con éxito."
    ]
  }
  ```

### 5. Renombrar Proyecto
* **Endpoint**: `POST /api/projects/rename`
* **Descripción**: Renombra físicamente un proyecto, actualiza su `package.json`, modifica su entrada en el catálogo central `projects.json`, actualiza los registros DNS en Cloudflare y realiza un commit/push en el monorepositorio.
* **Payload JSON requerido**:
  ```json
  {
    "oldName": "nombre-antiguo",
    "newName": "nombre-nuevo"
  }
  ```
* **Respuesta (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Proyecto renombrado con éxito a 'nombre-nuevo'.",
    "details": {
      "dirRenamed": true,
      "dnsDeleted": "Subdominio antiguo 'nombre-antiguo' eliminado.",
      "dnsCreated": "Subdominio nuevo 'nombre-nuevo' creado con éxito.",
      "gitStatus": "Confirmado y subido a GitHub con éxito."
    }
  }
  ```

---

## Estructura del Proyecto

El servicio de automatización está organizado de forma modular para facilitar su mantenimiento:
```text
crear-proyecto/
├── config/
│   └── env.js             # Centraliza la carga y validación de variables de entorno (.env)
├── services/
│   ├── scaffolderService.js # Lógica de copia de archivos, templates y reemplazo de placeholders
│   ├── gitService.js       # Comandos git locales e interacción con la API de GitHub
│   └── dnsService.js       # Integración CNAME con Cloudflare mediante gestion-dominios
├── public/                # Panel web interactivo (Frontend HTML/CSS/JS)
├── server.js              # Servidor Express principal y definición de rutas
├── package.json
└── README.md
```
