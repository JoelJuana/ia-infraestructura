const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

let firebaseAdminApp = null;
let isFirebaseInitialized = false;
let initError = null;

// Helper para inicializar Firebase Admin
function initFirebaseAdmin() {
  try {
    // Si ya existe una app inicializada, la eliminamos antes de reinicializar
    if (firebaseAdminApp) {
      try {
        firebaseAdminApp.delete();
      } catch (err) {
        console.error('Error al destruir la app de Firebase previa:', err.message);
      }
      firebaseAdminApp = null;
      isFirebaseInitialized = false;
      initError = null;
    }

    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH ||
      path.join(__dirname, 'serviceAccountKey.json');

    // Opción 1: Archivo JSON de Service Account
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      firebaseAdminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });
      // Establecer variable de entorno para que la CLI de Firebase también sepa dónde autenticarse
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(serviceAccountPath);
      isFirebaseInitialized = true;
      initError = null;
      console.log(`✓ Firebase inicializado con éxito usando: ${serviceAccountPath}`);
      return true;
    }

    // Opción 2: Variables de entorno individuales
    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      };

      firebaseAdminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.projectId
      });

      // Crear un archivo temporal serviceAccountKey_temp.json para que la CLI de Firebase pueda autenticarse
      const tempKeyPath = path.join(__dirname, 'serviceAccountKey_temp.json');
      fs.writeFileSync(
        tempKeyPath,
        JSON.stringify(
          {
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: privateKey,
            client_email: process.env.FIREBASE_CLIENT_EMAIL
          },
          null,
          2
        ),
        'utf8'
      );
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tempKeyPath;

      isFirebaseInitialized = true;
      initError = null;
      console.log('✓ Firebase inicializado con éxito usando variables individuales de entorno.');
      return true;
    }

    // Si no hay configuración explícita, intentamos inicialización por defecto
    try {
      firebaseAdminApp = admin.initializeApp();
      isFirebaseInitialized = true;
      initError = null;
      console.log('✓ Firebase inicializado usando credenciales predeterminadas del sistema.');
      return true;
    } catch (e) {
      initError =
        'Falta configuración de Firebase. Configura la Service Account mediante .env o crea un archivo serviceAccountKey.json.';
      console.warn('⚠️ Firebase no ha sido inicializado:', initError);
      return false;
    }
  } catch (err) {
    initError = err.message;
    console.error('❌ Error al inicializar Firebase Admin:', err);
    return false;
  }
}

// Inicialización inicial
initFirebaseAdmin();

// Middleware para verificar la inicialización de Firebase antes de acceder a servicios de base de datos
function checkFirebase(req, res, next) {
  if (!isFirebaseInitialized) {
    return res.status(503).json({
      error: 'Servicio Firebase no disponible',
      message: initError || 'Firebase no está inicializado. Configura tus credenciales primero.'
    });
  }
  next();
}

// Helper para guardar variables en el archivo .env (reutiliza el patrón del proyecto github)
function writeEnvFile(vars) {
  const envPath = path.join(__dirname, '.env');
  let currentEnv = {};

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        if (key) currentEnv[key] = val;
      }
    });
  }

  // Mezclar nuevas variables
  const updatedEnv = { ...currentEnv, ...vars };

  // Escribir el nuevo contenido
  const newContent = Object.entries(updatedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  fs.writeFileSync(envPath, newContent, 'utf8');

  // Actualizar process.env en tiempo de ejecución
  Object.entries(vars).forEach(([k, v]) => {
    process.env[k] = v;
  });

  // Reinicializar Firebase
  initFirebaseAdmin();
}

// --- Endpoints de Configuración ---

// Health Check
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    service: 'infra-firebase',
    port: PORT,
    initialized: isFirebaseInitialized
  });
});

// Obtener estado de configuración
app.get('/api/config', (req, res) => {
  // Enmascarar la llave privada si existe
  const hasPrivateKey = !!(process.env.FIREBASE_PRIVATE_KEY || '');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';

  let maskedEmail = '';
  if (clientEmail) {
    const parts = clientEmail.split('@');
    if (parts.length === 2) {
      maskedEmail = `${parts[0].substring(0, 4)}...@${parts[1]}`;
    } else {
      maskedEmail = '...';
    }
  }

  res.json({
    initialized: isFirebaseInitialized,
    error: initError,
    projectId: process.env.FIREBASE_PROJECT_ID || admin.app().options.projectId || '',
    clientEmail: maskedEmail,
    hasPrivateKey: hasPrivateKey,
    serviceAccountKeyPath: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || '',
    hasToken: !!process.env.FIREBASE_TOKEN
  });
});

// Guardar nueva configuración y reiniciar
app.post('/api/config', (req, res) => {
  const { projectId, clientEmail, privateKey, serviceAccountKeyPath, firebaseToken } = req.body;

  try {
    const varsToUpdate = {};

    if (projectId) varsToUpdate.FIREBASE_PROJECT_ID = projectId;
    if (clientEmail) varsToUpdate.FIREBASE_CLIENT_EMAIL = clientEmail;
    if (privateKey) varsToUpdate.FIREBASE_PRIVATE_KEY = privateKey;
    if (serviceAccountKeyPath)
      varsToUpdate.FIREBASE_SERVICE_ACCOUNT_KEY_PATH = serviceAccountKeyPath;
    if (firebaseToken) varsToUpdate.FIREBASE_TOKEN = firebaseToken;

    writeEnvFile(varsToUpdate);

    res.json({
      success: true,
      message: 'Configuración guardada con éxito. Instancia Firebase reinicializada.',
      initialized: isFirebaseInitialized,
      error: initError
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar configuración: ' + err.message });
  }
});

// --- Endpoints de Firestore ---

// Crear o actualizar documento
app.post('/api/firestore/document', checkFirebase, async (req, res) => {
  const { collection, id, data, merge } = req.body;

  if (!collection || !data) {
    return res.status(400).json({ error: 'Campos "collection" y "data" son requeridos.' });
  }

  try {
    const db = admin.firestore();
    let docRef;

    if (id) {
      docRef = db.collection(collection).doc(id);
      const shouldMerge = merge !== false; // merge por defecto true
      await docRef.set(data, { merge: shouldMerge });
    } else {
      // Si no viene id, se genera automáticamente
      docRef = await db.collection(collection).add(data);
    }

    res.json({
      success: true,
      id: docRef.id,
      path: `${collection}/${docRef.id}`,
      message: id ? 'Documento actualizado con éxito.' : 'Documento creado con éxito.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error en Firestore set/add: ' + err.message });
  }
});

// Obtener un documento por ID
app.get('/api/firestore/document/:collection/:id', checkFirebase, async (req, res) => {
  const { collection, id } = req.params;

  try {
    const doc = await admin.firestore().collection(collection).doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: `Documento "${id}" en "${collection}" no encontrado.` });
    }

    res.json({
      id: doc.id,
      exists: true,
      data: doc.data()
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar Firestore: ' + err.message });
  }
});

// Eliminar un documento por ID
app.delete('/api/firestore/document/:collection/:id', checkFirebase, async (req, res) => {
  const { collection, id } = req.params;

  try {
    const docRef = admin.firestore().collection(collection).doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: `Documento "${id}" en "${collection}" no encontrado.` });
    }

    await docRef.delete();

    res.json({
      success: true,
      message: `Documento "${id}" en la colección "${collection}" eliminado.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar en Firestore: ' + err.message });
  }
});

// Consultas filtradas
app.post('/api/firestore/query', checkFirebase, async (req, res) => {
  const { collection, filters, orderBy, limit, startAfter } = req.body;

  if (!collection) {
    return res.status(400).json({ error: 'El campo "collection" es requerido.' });
  }

  try {
    let query = admin.firestore().collection(collection);

    // Aplicar filtros where
    if (filters && Array.isArray(filters)) {
      filters.forEach(f => {
        if (f.field && f.operator && f.value !== undefined) {
          query = query.where(f.field, f.operator, f.value);
        }
      });
    }

    // Ordenar resultados
    if (orderBy) {
      if (typeof orderBy === 'object') {
        const field = orderBy.field;
        const direction = orderBy.direction || 'asc';
        if (field) {
          query = query.orderBy(field, direction);
        }
      } else if (typeof orderBy === 'string') {
        query = query.orderBy(orderBy);
      }
    }

    // Paginación startAfter
    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    // Límite de resultados
    if (limit) {
      query = query.limit(Number(limit));
    }

    const snapshot = await query.get();
    const results = [];

    snapshot.forEach(doc => {
      results.push({
        id: doc.id,
        data: doc.data()
      });
    });

    res.json({
      success: true,
      count: results.length,
      results: results
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar Firestore con filtros: ' + err.message });
  }
});

// Listar colecciones raíz
app.get('/api/firestore/collections', checkFirebase, async (req, res) => {
  try {
    const db = admin.firestore();
    const collections = await db.listCollections();
    const ids = collections.map(col => col.id);

    res.json({
      success: true,
      collections: ids
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar colecciones: ' + err.message });
  }
});

// --- Endpoints de Firebase Auth ---

// Crear usuario
app.post('/api/auth/user', checkFirebase, async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Los campos "email" y "password" son obligatorios.' });
  }

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: displayName || undefined
    });

    res.json({
      success: true,
      uid: userRecord.uid,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear usuario en Auth: ' + err.message });
  }
});

// Obtener usuario
app.get('/api/auth/user/:uid', checkFirebase, async (req, res) => {
  const { uid } = req.params;

  try {
    const userRecord = await admin.auth().getUser(uid);
    res.json({
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName,
      emailVerified: userRecord.emailVerified,
      disabled: userRecord.disabled,
      metadata: userRecord.metadata
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar Auth: ' + err.message });
  }
});

// Listar usuarios
app.get('/api/auth/users', checkFirebase, async (req, res) => {
  const maxResults = Number(req.query.maxResults || 100);

  try {
    const listUsersResult = await admin.auth().listUsers(maxResults);
    const users = listUsersResult.users.map(u => ({
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      disabled: u.disabled
    }));

    res.json({
      success: true,
      count: users.length,
      users: users
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar usuarios de Auth: ' + err.message });
  }
});

// Eliminar usuario
app.delete('/api/auth/user/:uid', checkFirebase, async (req, res) => {
  const { uid } = req.params;

  try {
    await admin.auth().deleteUser(uid);
    res.json({
      success: true,
      message: `Usuario con UID "${uid}" eliminado de Firebase Auth.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario en Auth: ' + err.message });
  }
});

// --- Endpoint de Firebase Hosting Deploy ---

// Desplegar carpeta a Hosting
app.post('/api/hosting/deploy', async (req, res) => {
  const { folderPath, projectId } = req.body;

  if (!folderPath) {
    return res.status(400).json({ error: 'El campo "folderPath" es requerido.' });
  }

  // Validar que la ruta existe
  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    return res.status(400).json({
      error: `La carpeta local especificada no existe: ${resolvedPath}`
    });
  }

  // Determinar proyecto ID a usar
  // Prioridad: 1. Body param, 2. .env FIREBASE_PROJECT_ID, 3. .firebaserc
  let activeProjectId = projectId || process.env.FIREBASE_PROJECT_ID;
  if (!activeProjectId) {
    const firebasercPath = path.join(__dirname, '.firebaserc');
    if (fs.existsSync(firebasercPath)) {
      try {
        const rc = JSON.parse(fs.readFileSync(firebasercPath, 'utf8'));
        activeProjectId = rc.projects?.default;
      } catch (err) {
        console.warn('Error al leer .firebaserc:', err.message);
      }
    }
  }

  if (!activeProjectId) {
    return res.status(400).json({
      error:
        'ID del proyecto Firebase no definido. Especifícalo en la petición o configura el proyecto por defecto.'
    });
  }

  const tempConfigPath = path.join(__dirname, 'firebase_deploy_temp.json');
  try {
    // 1. Crear configuración temporal de hosting que apunta al public folder path
    const deployConfig = {
      hosting: {
        public: resolvedPath,
        ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
        rewrites: [
          {
            source: '**',
            destination: '/index.html'
          }
        ]
      }
    };
    fs.writeFileSync(tempConfigPath, JSON.stringify(deployConfig, null, 2), 'utf8');

    // 2. Construir comando de deploy usando npx y no interactivo
    let cmd = `npx firebase deploy --only hosting --config "${tempConfigPath}" --project "${activeProjectId}" --non-interactive`;

    // Si existe token explícito, lo pasamos
    if (process.env.FIREBASE_TOKEN) {
      cmd += ` --token "${process.env.FIREBASE_TOKEN}"`;
    }

    console.log(
      `Desplegando hosting en proyecto "${activeProjectId}" usando ruta: "${resolvedPath}"`
    );
    console.log(`Comando: ${cmd}`);

    // 3. Ejecutar el comando de forma asíncrona prometizada para capturar salida
    const { stdout, stderr } = await execPromise(cmd, {
      cwd: __dirname,
      env: { ...process.env } // Contiene GOOGLE_APPLICATION_CREDENTIALS o variables de service account
    });

    // 4. Limpiar archivo de configuración temporal
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }

    // Extraer URL si está presente en stdout (Firebase CLI suele mostrar la URL final al desplegar)
    let deployUrl = `https://${activeProjectId}.web.app`;
    const urlMatch = stdout.match(/Hosting URL:\s*(https:\/\/\S+)/i);
    if (urlMatch && urlMatch[1]) {
      deployUrl = urlMatch[1];
    }

    res.json({
      success: true,
      message: 'Despliegue de Firebase Hosting completado con éxito.',
      deployUrl,
      output: stdout,
      errors: stderr || null
    });
  } catch (err) {
    // Asegurarse de limpiar el archivo temporal de todas formas
    if (fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (_) {
        // Ignorar errores al intentar eliminar el archivo temporal
      }
    }

    res.status(500).json({
      error: 'Fallo al desplegar en Firebase Hosting',
      message: err.message,
      output: err.stdout || null,
      errors: err.stderr || null
    });
  }
});

// --- Endpoint de Workflow Multi-paso (secuencia automatizada) ---

app.post('/api/workflow', checkFirebase, async (req, res) => {
  const { steps } = req.body;

  if (!steps || !Array.isArray(steps)) {
    return res.status(400).json({ error: 'Se requiere una lista de pasos en el campo "steps".' });
  }

  const results = [];
  let errorOccurred = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepIndex = i + 1;
    const { action } = step;

    if (!action) {
      results.push({ step: stepIndex, error: 'Acción no especificada.' });
      errorOccurred = true;
      break;
    }

    try {
      console.log(`Ejecutando paso de workflow ${stepIndex}: ${action}`);

      if (action === 'firestore.set') {
        const { collection, id, data, merge } = step;
        if (!collection || !data) {
          throw new Error('Faltan campos "collection" o "data" para firestore.set');
        }
        const db = admin.firestore();
        let docRef;
        if (id) {
          docRef = db.collection(collection).doc(id);
          await docRef.set(data, { merge: merge !== false });
        } else {
          docRef = await db.collection(collection).add(data);
        }
        results.push({
          step: stepIndex,
          action,
          success: true,
          data: { id: docRef.id, path: `${collection}/${docRef.id}` }
        });
      } else if (action === 'firestore.delete') {
        const { collection, id } = step;
        if (!collection || !id) {
          throw new Error('Faltan campos "collection" o "id" para firestore.delete');
        }
        await admin.firestore().collection(collection).doc(id).delete();
        results.push({
          step: stepIndex,
          action,
          success: true
        });
      } else if (action === 'hosting.deploy') {
        const { folderPath, projectId } = step;
        if (!folderPath) {
          throw new Error('Falta el campo "folderPath" para hosting.deploy');
        }

        // Simular llamada interna a la lógica de Hosting Deploy para evitar lanzar subprocesos anidados y
        // mantener el código libre de dependencias complejas. Usamos fetch local o llamamos al helper de deploy.
        // Como este es un proceso asíncrono largo, implementamos la misma lógica del handler directamente aquí.
        const resolvedPath = path.resolve(folderPath);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`La carpeta local especificada no existe: ${resolvedPath}`);
        }

        let activeProjectId = projectId || process.env.FIREBASE_PROJECT_ID;
        if (!activeProjectId) {
          const firebasercPath = path.join(__dirname, '.firebaserc');
          if (fs.existsSync(firebasercPath)) {
            const rc = JSON.parse(fs.readFileSync(firebasercPath, 'utf8'));
            activeProjectId = rc.projects?.default;
          }
        }

        if (!activeProjectId) {
          throw new Error('ID del proyecto Firebase no definido para el deploy.');
        }

        const tempConfigPath = path.join(__dirname, 'firebase_deploy_temp.json');
        const deployConfig = {
          hosting: {
            public: resolvedPath,
            ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
            rewrites: [{ source: '**', destination: '/index.html' }]
          }
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(deployConfig, null, 2), 'utf8');

        let cmd = `npx firebase deploy --only hosting --config "${tempConfigPath}" --project "${activeProjectId}" --non-interactive`;
        if (process.env.FIREBASE_TOKEN) {
          cmd += ` --token "${process.env.FIREBASE_TOKEN}"`;
        }

        const { stdout } = await execPromise(cmd, {
          cwd: __dirname,
          env: { ...process.env }
        });

        if (fs.existsSync(tempConfigPath)) {
          fs.unlinkSync(tempConfigPath);
        }

        let deployUrl = `https://${activeProjectId}.web.app`;
        const urlMatch = stdout.match(/Hosting URL:\s*(https:\/\/\S+)/i);
        if (urlMatch && urlMatch[1]) {
          deployUrl = urlMatch[1];
        }

        results.push({
          step: stepIndex,
          action,
          success: true,
          data: { deployUrl, projectId: activeProjectId }
        });
      } else if (action === 'auth.createUser') {
        const { email, password, displayName } = step;
        if (!email || !password) {
          throw new Error('Faltan campos "email" o "password" para auth.createUser');
        }
        const userRecord = await admin.auth().createUser({ email, password, displayName });
        results.push({
          step: stepIndex,
          action,
          success: true,
          data: { uid: userRecord.uid, email: userRecord.email }
        });
      } else {
        throw new Error(`Acción desconocida o no implementada en workflow: ${action}`);
      }
    } catch (err) {
      console.error(`Error en paso de workflow ${stepIndex}:`, err.message);
      results.push({
        step: stepIndex,
        action,
        success: false,
        error: err.message
      });
      errorOccurred = true;
      break; // Abortar flujo si un paso falla
    }
  }

  res.status(errorOccurred ? 500 : 200).json({
    success: !errorOccurred,
    results
  });
});

// --- Endpoint de Apagado (Shutdown) ---
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de Firebase...');
  setTimeout(() => {
    // Si creamos un archivo serviceAccountKey_temp.json temporal, lo limpiamos al apagar
    const tempKeyPath = path.join(__dirname, 'serviceAccountKey_temp.json');
    if (fs.existsSync(tempKeyPath)) {
      try {
        fs.unlinkSync(tempKeyPath);
        console.log('Limpiado serviceAccountKey_temp.json temporal.');
      } catch (_) {
        // Ignorar errores al limpiar el archivo temporal de service account
      }
    }
    process.exit(0);
  }, 1000);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('=================================================');
  console.log(` Firebase Automation Service corriendo en: http://localhost:${PORT}`);
  console.log('=================================================');
});
