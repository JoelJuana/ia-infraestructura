# Reglas del Proyecto: IA_Infraestructura

Este espacio aloja el API Gateway y los microservicios locales encargados de dar soporte al desarrollo y la automatización del monorepositorio de IA.

## 1. Arquitectura de Red y Puertos
*   Los puertos en el rango **3000 al 3799** están estrictamente reservados para la infraestructura. Nunca los asignes a aplicaciones de negocio.
*   **Catálogo de Puertos Reservados**:
    *   `3000`: API Gateway central (`/api/health`)
    *   `3100`: `infra-github` (`/api/git`)
    *   `3200`: `infra-firebase` (`/api/fb`)
    *   `3300`: `infra-project-creator` (`/api/proj`)
    *   `3400`: `infra-domain-manager` (`/api/dns`)
    *   `3500`: `api-design-assets` (`/api/design`)
    *   `3600`: `api-conocimiento-rag` (`/api/rag`)
    *   `3700`: `api-utilidades-scraping` (`/api/scrape`)

## 2. Gestión del Ciclo de Vida de los Servicios
*   **Arranque JIT (Just-In-Time)**: Si necesitas interactuar con algún servicio y el Gateway está apagado, ejecútalo inmediatamente con `npm run start`.
*   **Apagado Obligatorio al Finalizar**: Para evitar el consumo continuo de CPU/RAM y bloqueos de puertos en la máquina local (Lenovo Snapdragon ARM64), **debes apagar todos los servicios ejecutando `npm run stop` antes de entregar tu respuesta de cierre final al usuario**.

## 3. Seguridad y Variables de Entorno
*   Los microservicios (GitHub, Firebase, Cloudflare) requieren variables de entorno configuradas en archivos `.env` individuales en sus carpetas.
*   **Nunca** expongas ni guardes en commits tokens de API, contraseñas o credenciales en texto plano. Asegúrate de que los archivos `.env` estén ignorados en el `.gitignore`.

## 4. Control de Versiones (Git)
*   Este es un repositorio Git independiente. Sube tus aportes de infraestructura siguiendo los Conventional Commits (`feat(gateway): ...`, `fix(github): ...`).
*   Los cambios deben ser empujados a la rama `main` al terminar.
