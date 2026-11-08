# infra-domain-manager

Microservicio encargado de gestionar registros DNS y subdominios de forma automatizada mediante la API de Cloudflare.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3400` (Gateway: `/api/dns`)
- **Ruta física**: `IA_Infraestructura/infra-domain-manager/`
- **Requiere variables de entorno (.env)**: Sí
  - `CLOUDFLARE_API_TOKEN`: Token de API con permisos de edición de zona de Cloudflare.
  - `CLOUDFLARE_ZONE_ID`: ID de la zona correspondiente al dominio principal.
  - `CLOUDFLARE_ACCOUNT_ID`: ID de la cuenta de Cloudflare.
  - `CLOUDFLARE_BASE_DOMAIN`: Dominio raíz para los subdominios (ej. `joeljuana.com`).
  - `ENCRYPTION_KEY`: Clave de cifrado simétrico para asegurar configuraciones sensibles.

## ⚙️ Funciones Clave

1. **Gestión de CNAMEs**: Creación y eliminación automática de subdominios del tipo `proyecto.dominio.com` apuntando a Firebase Hosting (`.web.app`) o servidores locales.
2. **Control de Proxy (Cloudflare CDN)**: Permite habilitar o deshabilitar el proxy de Cloudflare (nube naranja/gris) en cada registro.
3. **Auditoría DNS**: Consulta y validación del estado de los registros DNS de forma remota.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/dns/records` | Lista todos los registros DNS configurados en la zona |
| `POST` | `/api/dns/records` | Crea un nuevo registro DNS (A, CNAME, TXT, etc.) |
| `DELETE` | `/api/dns/records/:id` | Elimina un registro DNS específico por su ID de Cloudflare |
| `POST` | `/api/dns/cname` | Crea o actualiza rápidamente un subdominio CNAME para un proyecto |
| `GET` | `/ping` | Healthcheck del servicio |
| `POST` | `/api/shutdown` | Cierre limpio del servidor |
