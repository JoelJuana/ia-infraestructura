# infra-firebase

Microservicio que actúa como interfaz REST local para interactuar con Firebase (Firestore, Auth y Hosting Deploy) sin depender directamente de la CLI de Firebase en el agente.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3200` (Gateway: `/api/fb`)
- **Ruta física**: `IA_Infraestructura/infra-firebase/`
- **Requiere variables de entorno (.env)**: Sí
  - `FIREBASE_PROJECT_ID`: ID del proyecto de Firebase.
  - `FIREBASE_CLIENT_EMAIL`: Email de la cuenta de servicio.
  - `FIREBASE_PRIVATE_KEY`: Clave privada de la cuenta de servicio (formato multilínea escapado).
  - O alternativamente `FIREBASE_SERVICE_ACCOUNT_KEY_PATH` que apunta al archivo JSON local de credenciales.

## ⚙️ Funciones Clave

1. **Firestore CRUD**: Crear, leer, actualizar, borrar y consultar documentos y colecciones mediante peticiones HTTP.
2. **Auth API**: Administración de usuarios (creación, listado, borrado por UID).
3. **Hosting Deployment**:
   - Permite subir carpetas compiladas (ej. `dist/`, `build/`) directamente a Firebase Hosting mediante su API.
   - Retorna la URL del despliegue exitoso (`deployUrl`).
4. **Operaciones en Lote (Batch)**: Ejecuta una serie de acciones secuenciales (ej. subir a Firestore y luego desplegar) en una sola llamada.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/firestore/set` | Guarda o actualiza un documento en una colección |
| `GET` | `/api/firestore/get/:collection/:id` | Recupera un documento por colección e ID |
| `DELETE` | `/api/firestore/delete/:collection/:id` | Elimina un documento por colección e ID |
| `POST` | `/api/firestore/query` | Realiza consultas avanzadas filtradas en Firestore |
| `POST` | `/api/auth/register` | Registra un nuevo usuario en Firebase Auth |
| `GET` | `/api/auth/users` | Lista todos los usuarios de Auth |
| `DELETE` | `/api/auth/users/:uid` | Elimina un usuario por UID |
| `POST` | `/api/hosting/deploy` | Despliega una carpeta al hosting y retorna la URL |
| `POST` | `/api/batch` | Ejecuta un lote de pasos de Firestore y Hosting en una petición |
| `GET` | `/ping` | Healthcheck del servicio |
