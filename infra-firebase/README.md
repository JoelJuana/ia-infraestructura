# Firebase Automation Service

API REST local y servicio de automatización de Firebase diseñado específicamente para ser consumido programáticamente por la suite de agentes autónomos del monorepositorio.

Este servicio encapsula `firebase-admin` y la CLI de Firebase para interactuar con Firestore, Firebase Auth y Firebase Hosting sin necesidad de interactuar manualmente con consolas web. Corresponde al mismo enfoque y estructura que el servicio de automatización de Git/GitHub (`github`).

---

## Características

- **Inicialización flexible:** Puede arrancar usando un archivo `serviceAccountKey.json` en local o pasando las variables individuales de credenciales mediante el archivo `.env`.
- **API REST completa de Firestore:** Endpoints para crear/actualizar documentos, hacer consultas estructuradas con filtros de igualdad/rango, eliminar documentos y listar colecciones.
- **API REST completa de Auth:** Administración rápida de usuarios de Firebase Auth (registro, consulta, eliminación y listado).
- **Despliegues autónomos a Hosting:** Endpoint que acepta una ruta de carpeta local y la sube de forma transparente a Firebase Hosting con configuraciones temporales seguras.
- **Workflow multi-paso:** Permite encadenar múltiples escrituras en base de datos y despliegues en una sola petición.
- **Apagado controlado:** Endpoint `/api/shutdown` para liberar puertos y memoria del sistema una vez completadas las tareas del agente.

---

## Configuración y Credenciales

El servicio busca las credenciales de Firebase en el archivo `.env` o en la raíz en la siguiente secuencia de prioridad:

### Opción A: Archivo `serviceAccountKey.json` (Recomendado)

Genera una llave privada de Service Account en formato JSON desde tu consola de Firebase (`Configuración del proyecto > Cuentas de servicio > Generar nueva clave privada`). Coloca el archivo renombrado como `serviceAccountKey.json` directamente en la raíz de esta carpeta.

O bien, indica su ubicación en el `.env`:

```env
FIREBASE_SERVICE_ACCOUNT_KEY_PATH=./serviceAccountKey.json
```

### Opción B: Variables de entorno individuales

Si prefieres no dejar archivos físicos con secretos, puedes definir los campos directamente en el archivo `.env` local:

```env
FIREBASE_PROJECT_ID=tu-proyecto-firebase
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tu-proyecto-firebase.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDd...\n-----END PRIVATE KEY-----\n"
```

_Nota: Asegúrate de envolver la clave privada entre comillas y conservar los saltos de línea `\n`._

### Opción C: Token de Firebase CI (Para Hosting)

Para el despliegue automático a Hosting, puedes opcionalmente usar un token de autenticación CI/CD:

```env
FIREBASE_TOKEN=1//0xxxxxxxxxxxxxxxxxxxx
```

---

## Instalación y Arranque

1. **Instalar dependencias:**

   ```bash
   npm install
   ```

2. **Ejecutar diagnóstico y setup automático:**
   El script comprobará la validez de las credenciales de Firebase e intentará conectarse para realizar una comprobación de salud de los servicios de Firestore y Auth.

   ```bash
   node setup_firebase.js
   ```

3. **Iniciar el servidor local:**
   Inicia la API Express en el puerto `4001`:
   ```bash
   npm start
   ```

---

## Referencia de Endpoints API

### 1. Estado y Configuración

#### Health Check

- **Método / Ruta:** `GET /ping`
- **Respuesta:**
  ```json
  {
    "status": "ok",
    "service": "infra-firebase",
    "port": 4001,
    "initialized": true
  }
  ```

#### Obtener Configuración

- **Método / Ruta:** `GET /api/config`
- **Respuesta:** Retorna el estado del servicio y datos no sensibles.
  ```json
  {
    "initialized": true,
    "projectId": "proyectos-ia-4fa3f",
    "clientEmail": "fire...@proyectos-ia-4fa3f.iam.gserviceaccount.com",
    "hasPrivateKey": true,
    "serviceAccountKeyPath": ""
  }
  ```

#### Actualizar Configuración

Permite a los agentes reconfigurar el servicio de Firebase en tiempo de ejecución. Guarda los datos en el `.env` y reinicia el SDK de Firebase Admin de forma segura.

- **Método / Ruta:** `POST /api/config`
- **Cuerpo (JSON):**
  ```json
  {
    "projectId": "proyectos-ia-4fa3f",
    "clientEmail": "correo-service-account@...",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...",
    "serviceAccountKeyPath": "./serviceAccountKey.json"
  }
  ```

---

### 2. Firestore

#### Crear o Actualizar Documento

- **Método / Ruta:** `POST /api/firestore/document`
- **Cuerpo (JSON):**
  ```json
  {
    "collection": "leads",
    "id": "lead-001", // Opcional. Si se omite, Firestore generará un ID aleatorio.
    "data": {
      "nombre": "Joel",
      "email": "joel@mail.com",
      "rol": "admin"
    },
    "merge": true // Opcional. Por defecto es true.
  }
  ```

#### Obtener Documento

- **Método / Ruta:** `GET /api/firestore/document/:collection/:id`
- **Respuesta (200):**
  ```json
  {
    "id": "lead-001",
    "exists": true,
    "data": {
      "nombre": "Joel",
      "email": "joel@mail.com",
      "rol": "admin"
    }
  }
  ```

#### Eliminar Documento

- **Método / Ruta:** `DELETE /api/firestore/document/:collection/:id`

#### Consultar Documentos (Query)

- **Método / Ruta:** `POST /api/firestore/query`
- **Cuerpo (JSON):**
  ```json
  {
    "collection": "leads",
    "filters": [{ "field": "rol", "operator": "==", "value": "admin" }],
    "orderBy": { "field": "email", "direction": "asc" }, // Opcional. También acepta un string simple.
    "limit": 10 // Opcional.
  }
  ```

#### Listar Colecciones

- **Método / Ruta:** `GET /api/firestore/collections`

---

### 3. Firebase Auth

#### Crear Usuario

- **Método / Ruta:** `POST /api/auth/user`
- **Cuerpo (JSON):**
  ```json
  {
    "email": "usuario@proyectos.com",
    "password": "claveSegura123",
    "displayName": "Usuario Suite"
  }
  ```

#### Listar Usuarios

- **Método / Ruta:** `GET /api/auth/users?maxResults=50`

#### Eliminar Usuario

- **Método / Ruta:** `DELETE /api/auth/user/:uid`

---

### 4. Firebase Hosting

#### Desplegar Carpeta

Despliega el contenido de un directorio local de manera autónoma.

- **Método / Ruta:** `POST /api/hosting/deploy`
- **Cuerpo (JSON):**
  ```json
  {
    "folderPath": "./dist", // Ruta absoluta o relativa al directorio local
    "projectId": "proyectos-ia-4fa3f" // Opcional si ya se configuró el proyecto por defecto
  }
  ```
- **Respuesta (200):**
  ```json
  {
    "success": true,
    "message": "Despliegue de Firebase Hosting completado con éxito.",
    "deployUrl": "https://proyectos-ia-4fa3f.web.app",
    "output": "...[consola de firebase deploy]..."
  }
  ```

---

### 5. Flujo de Trabajo Completo y Apagado

#### Ejecutar Workflow en Secuencia

- **Método / Ruta:** `POST /api/workflow`
- **Cuerpo (JSON):**
  ```json
  {
    "steps": [
      {
        "action": "firestore.set",
        "collection": "estado_despliegues",
        "id": "landing_leads",
        "data": { "status": "deploying", "timestamp": "2026-06-30" }
      },
      {
        "action": "hosting.deploy",
        "folderPath": "./dist"
      },
      {
        "action": "firestore.set",
        "collection": "estado_despliegues",
        "id": "landing_leads",
        "data": { "status": "deployed", "timestamp": "2026-06-30" }
      }
    ]
  }
  ```

#### Apagar Servidor (Libera Puerto 4001)

- **Método / Ruta:** `POST /api/shutdown`
- **Cuerpo (JSON):** `{}`
