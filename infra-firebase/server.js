const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { execFile, execSync } = require('child_process');
const util = require('util');
const {
  LOCAL_HOST,
  createLocalCorsOptions,
  localSecurityMiddleware,
  writeEnvFileSafe,
  getProcessMetrics
} = require('../packages/shared/index.cjs');

const execFilePromise = util.promisify(execFile);

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || process.env.FIREBASE_SERVICE_PORT || 3200);
const TEMP_KEY_PATH = path.join(__dirname, 'serviceAccountKey_temp.json');

app.use(localSecurityMiddleware);
app.use(cors(createLocalCorsOptions()));
app.use(express.json({ limit: '50mb' }));
app.use((req, _res, next) => {
  // Normalizar rutas cuando entran por el API Gateway (/api/fb/hosting/deploy -> /api/hosting/deploy)
  if (req.url !== '/' && !req.url.startsWith('/ping') && !req.url.startsWith('/api/')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  next();
});

let firebaseAdminApp = null;
let isFirebaseInitialized = false;
let initError = null;

/**
 * Elimina cualquier clave temporal generada en disco al salir del proceso.
 */
function cleanupTempCredentials() {
  if (fs.existsSync(TEMP_KEY_PATH)) {
    try {
      fs.unlinkSync(TEMP_KEY_PATH);
    } catch {
      // Ignorar errores de limpieza en salida
    }
  }
}

process.on('exit', cleanupTempCredentials);
process.on('SIGINT', () => {
  cleanupTempCredentials();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupTempCredentials();
  process.exit(0);
});

// Helper para inicializar Firebase Admin
function initFirebaseAdmin() {
  try {
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
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(serviceAccountPath);
      isFirebaseInitialized = true;
      initError = null;
      console.log(`Firebase inicializado con éxito usando Service Account local.`);
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
        privateKey
      };

      firebaseAdminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.projectId
      });

      fs.writeFileSync(
        TEMP_KEY_PATH,
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
        { encoding: 'utf8', mode: 0o600 }
      );
      process.env.GOOGLE_APPLICATION_CREDENTIALS = TEMP_KEY_PATH;

      isFirebaseInitialized = true;
      initError = null;
      console.log('Firebase inicializado con éxito usando variables individuales de entorno.');
      return true;
    }

    // Opción 3: Credenciales predeterminadas del entorno (ADC)
    try {
      firebaseAdminApp = admin.initializeApp();
      isFirebaseInitialized = true;
      initError = null;
      console.log('Firebase inicializado usando credenciales predeterminadas del sistema.');
      return true;
    } catch {
      initError =
        'Falta configuración de Firebase. Configura la Service Account mediante .env o crea un archivo serviceAccountKey.json.';
      console.warn('Firebase no ha sido inicializado:', initError);
      return false;
    }
  } catch (err) {
    initError = err.message;
    console.error('Error al inicializar Firebase Admin:', err.message);
    return false;
  }
}

if (process.env.NODE_ENV !== 'test') {
  initFirebaseAdmin();
}

function checkFirebase(_req, res, next) {
  if (!isFirebaseInitialized) {
    return res.status(503).json({
      error: 'Servicio Firebase no disponible',
      message: initError || 'Firebase no está inicializado. Configura tus credenciales primero.'
    });
  }
  return next();
}

function writeEnvFile(vars) {
  const envPath = path.join(__dirname, '.env');
  writeEnvFileSafe(envPath, vars);
  initFirebaseAdmin();
}

/**
 * Resuelve el comando óptimo de Firebase CLI evitando sobrecarga de npx si existe instalación local/global.
 */
let cachedFirebaseCli = null;
function resolveFirebaseCliExecutable() {
  if (cachedFirebaseCli) return cachedFirebaseCli;

  const isWin = process.platform === 'win32';
  const localBin = path.resolve(__dirname, '..', 'node_modules', '.bin', isWin ? 'firebase.cmd' : 'firebase');
  const svcBin = path.resolve(__dirname, 'node_modules', '.bin', isWin ? 'firebase.cmd' : 'firebase');

  if (fs.existsSync(svcBin)) {
    cachedFirebaseCli = { bin: svcBin, prefixArgs: [], needsCmdShim: isWin };
    return cachedFirebaseCli;
  }
  if (fs.existsSync(localBin)) {
    cachedFirebaseCli = { bin: localBin, prefixArgs: [], needsCmdShim: isWin };
    return cachedFirebaseCli;
  }

  try {
    const finder = isWin ? 'where firebase.cmd' : 'which firebase';
    const found = execSync(finder, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    if (found && fs.existsSync(found)) {
      cachedFirebaseCli = { bin: found, prefixArgs: [], needsCmdShim: isWin };
      return cachedFirebaseCli;
    }
  } catch {
    // Fallback a npx
  }

  cachedFirebaseCli = {
    bin: isWin ? 'npx.cmd' : 'npx',
    prefixArgs: ['firebase-tools'],
    needsCmdShim: isWin
  };
  return cachedFirebaseCli;
}

/**
 * Ejecuta un despliegue de Firebase Hosting de forma segura (sin exponer FIREBASE_TOKEN en logs ni en línea de comandos).
 */
async function executeFirebaseHostingDeploy({ resolvedPath, activeProjectId, siteId = null, noCacheHeaders = false }) {
  const suffix = `${Date.now()}_${process.pid}`;
  const tempConfigPath = path.join(__dirname, `firebase_deploy_temp_${suffix}.json`);

  const hostingBlock = {
    ...(siteId ? { site: siteId } : {}),
    public: resolvedPath,
    ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
    rewrites: [{ source: '**', destination: '/index.html' }],
    ...(noCacheHeaders
      ? {
          headers: [
            {
              source: '**',
              headers: [
                {
                  key: 'Cache-Control',
                  value: 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=0'
                }
              ]
            }
          ]
        }
      : {})
  };

  try {
    fs.writeFileSync(tempConfigPath, JSON.stringify({ hosting: hostingBlock }, null, 2), 'utf8');

    const cli = resolveFirebaseCliExecutable();
    const cliArgs = [
      ...cli.prefixArgs,
      'deploy',
      '--only',
      'hosting',
      '--config',
      tempConfigPath,
      '--project',
      activeProjectId,
      '--non-interactive'
    ];

    if (process.env.FIREBASE_TOKEN) {
      cliArgs.push('--token', process.env.FIREBASE_TOKEN);
    }

    // Registrar en logs siempre con el token enmascarado
    const safeArgsLog = cliArgs.map((arg, idx) => (cliArgs[idx - 1] === '--token' ? '***REDACTED***' : arg)).join(' ');
    console.log(`[Firebase Deploy] Ejecutando: ${path.basename(cli.bin)} ${safeArgsLog}`);

    let execBin = cli.bin;
    let execArgs = cliArgs;
    if (cli.needsCmdShim) {
      execBin = process.env.ComSpec || 'cmd.exe';
      execArgs = ['/d', '/s', '/c', cli.bin, ...cliArgs];
    }

    const { stdout, stderr } = await execFilePromise(execBin, execArgs, {
      cwd: __dirname,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env }
    });

    let deployUrl = `https://${siteId || activeProjectId}.web.app`;
    const urlMatch = stdout.match(/Hosting URL:\s*(https:\/\/\S+)/i);
    if (urlMatch && urlMatch[1]) {
      deployUrl = urlMatch[1];
    }

    return { stdout, stderr, deployUrl };
  } finally {
    if (fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath);
      } catch {
        // Ignorar errores de borrado temporal
      }
    }
  }
}

/**
 * Resuelve el Project ID activo usando parámetro explícito, .env, instancia Admin o .firebaserc.
 */
function resolveActiveProjectId(explicitProjectId) {
  if (explicitProjectId) return explicitProjectId;
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (isFirebaseInitialized) {
    try {
      const fromApp = admin.app().options.projectId;
      if (fromApp) return fromApp;
    } catch {
      // Ignorar
    }
  }
  const firebasercPath = path.join(__dirname, '.firebaserc');
  if (fs.existsSync(firebasercPath)) {
    try {
      const rc = JSON.parse(fs.readFileSync(firebasercPath, 'utf8'));
      if (rc.projects?.default) return rc.projects.default;
    } catch {
      // Ignorar
    }
  }
  return null;
}

// --- Endpoints de Configuración ---

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'infra-firebase',
    port: PORT,
    initialized: isFirebaseInitialized,
    status: 'online'
  });
});

app.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'infra-firebase',
    port: PORT,
    initialized: isFirebaseInitialized,
    ...getProcessMetrics()
  });
});

app.get('/api/config', (_req, res) => {
  const hasPrivateKey = !!(process.env.FIREBASE_PRIVATE_KEY || '');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';

  let maskedEmail = '';
  if (clientEmail) {
    const parts = clientEmail.split('@');
    maskedEmail = parts.length === 2 ? `${parts[0].substring(0, 4)}...@${parts[1]}` : '...';
  }

  let appProjectId = '';
  if (isFirebaseInitialized) {
    try {
      appProjectId = admin.app().options.projectId || '';
    } catch {
      appProjectId = '';
    }
  }

  res.json({
    initialized: isFirebaseInitialized,
    error: initError,
    projectId: process.env.FIREBASE_PROJECT_ID || appProjectId,
    clientEmail: maskedEmail,
    hasPrivateKey,
    serviceAccountKeyPath: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || '',
    hasToken: !!process.env.FIREBASE_TOKEN
  });
});

app.post('/api/config', (req, res) => {
  const { projectId, clientEmail, privateKey, serviceAccountKeyPath, firebaseToken } = req.body;

  try {
    const varsToUpdate = {};

    if (projectId) varsToUpdate.FIREBASE_PROJECT_ID = projectId;
    if (clientEmail) varsToUpdate.FIREBASE_CLIENT_EMAIL = clientEmail;
    if (privateKey) varsToUpdate.FIREBASE_PRIVATE_KEY = privateKey;
    if (serviceAccountKeyPath) varsToUpdate.FIREBASE_SERVICE_ACCOUNT_KEY_PATH = serviceAccountKeyPath;
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
      const shouldMerge = merge !== false;
      await docRef.set(data, { merge: shouldMerge });
    } else {
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

app.post('/api/firestore/query', checkFirebase, async (req, res) => {
  const { collection, filters, orderBy, limit, startAfter } = req.body;

  if (!collection) {
    return res.status(400).json({ error: 'El campo "collection" es requerido.' });
  }

  try {
    let query = admin.firestore().collection(collection);

    if (filters && Array.isArray(filters)) {
      filters.forEach((f) => {
        if (f.field && f.operator && f.value !== undefined) {
          query = query.where(f.field, f.operator, f.value);
        }
      });
    }

    if (orderBy) {
      if (typeof orderBy === 'object' && orderBy.field) {
        query = query.orderBy(orderBy.field, orderBy.direction || 'asc');
      } else if (typeof orderBy === 'string') {
        query = query.orderBy(orderBy);
      }
    }

    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    if (limit) {
      query = query.limit(Number(limit));
    }

    const snapshot = await query.get();
    const results = [];

    snapshot.forEach((doc) => {
      results.push({
        id: doc.id,
        data: doc.data()
      });
    });

    res.json({
      success: true,
      count: results.length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar Firestore con filtros: ' + err.message });
  }
});

app.get('/api/firestore/collections', checkFirebase, async (_req, res) => {
  try {
    const db = admin.firestore();
    const collections = await db.listCollections();
    const ids = collections.map((col) => col.id);

    res.json({
      success: true,
      collections: ids
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar colecciones: ' + err.message });
  }
});

// --- Endpoints de Firebase Auth ---

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

app.get('/api/auth/users', checkFirebase, async (req, res) => {
  const maxResults = Number(req.query.maxResults || 100);

  try {
    const listUsersResult = await admin.auth().listUsers(maxResults);
    const users = listUsersResult.users.map((u) => ({
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      disabled: u.disabled
    }));

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar usuarios de Auth: ' + err.message });
  }
});

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

app.post('/api/hosting/deploy', async (req, res) => {
  const { folderPath, projectId } = req.body;

  if (!folderPath) {
    return res.status(400).json({ error: 'El campo "folderPath" es requerido.' });
  }

  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    return res.status(400).json({
      error: `La carpeta local especificada no existe: ${resolvedPath}`
    });
  }

  const activeProjectId = resolveActiveProjectId(projectId);
  if (!activeProjectId) {
    return res.status(400).json({
      error: 'ID del proyecto Firebase no definido. Especifícalo en la petición o configura el proyecto por defecto.'
    });
  }

  try {
    const { stdout, stderr, deployUrl } = await executeFirebaseHostingDeploy({
      resolvedPath,
      activeProjectId
    });

    res.json({
      success: true,
      message: 'Despliegue de Firebase Hosting completado con éxito.',
      deployUrl,
      output: stdout,
      errors: stderr || null
    });
  } catch (err) {
    res.status(500).json({
      error: 'Fallo al desplegar en Firebase Hosting',
      message: err.message,
      output: err.stdout || null,
      errors: err.stderr || null
    });
  }
});

// Helper para obtener el access token de Firebase
async function getFirebaseAccessToken() {
  try {
    const credential = admin.app().options.credential;
    if (credential && typeof credential.getAccessToken === 'function') {
      const tokenObj = await credential.getAccessToken();
      if (tokenObj && tokenObj.accessToken) {
        return tokenObj.accessToken;
      }
    }
  } catch (err) {
    console.warn('Advertencia al obtener token del Service Account (intentando fallback):', err.message);
  }

  let refreshToken = process.env.FIREBASE_TOKEN;
  if (!refreshToken) {
    const configPath = path.join(process.env.USERPROFILE || os.homedir(), '.config', 'configstore', 'firebase-tools.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        refreshToken = config.tokens?.refresh_token;
      } catch (err) {
        console.warn('Error al leer firebase-tools.json:', err.message);
      }
    }
  }

  if (!refreshToken) {
    throw new Error('Falta credencial de autenticación. Configura Service Account o ejecuta "firebase login" localmente.');
  }

  const oauthClientId = process.env.FIREBASE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.FIREBASE_OAUTH_CLIENT_SECRET;
  if (!oauthClientId || !oauthClientSecret) {
    throw new Error(
      'Faltan FIREBASE_OAUTH_CLIENT_ID o FIREBASE_OAUTH_CLIENT_SECRET en .env para intercambiar el refresh token.'
    );
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: oauthClientId,
    client_secret: oauthClientSecret,
    refresh_token: refreshToken
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Error en intercambio de OAuth2 token: ${data.error_description || data.error || 'Error desconocido'}`);
  }

  return data.access_token;
}

async function callFirebaseHostingAPI(endpoint, method, body = null) {
  const accessToken = await getFirebaseAccessToken();

  const url = `https://firebasehosting.googleapis.com/v1beta1/${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMsg = data.error?.message || `Error con estado HTTP ${response.status}`;
    throw new Error(errorMsg);
  }
  return data;
}

// Crear sitio de hosting multisitio
app.post('/api/hosting/sites/create', async (req, res) => {
  const { siteId, projectId } = req.body;

  if (!siteId) {
    return res.status(400).json({ error: 'El campo "siteId" es requerido.' });
  }

  const activeProjectId = resolveActiveProjectId(projectId);
  if (!activeProjectId) {
    return res.status(400).json({
      error: 'ID del proyecto Firebase no definido. Especifícalo en la petición o configura el proyecto por defecto.'
    });
  }

  try {
    const result = await callFirebaseHostingAPI(
      `projects/${activeProjectId}/sites?siteId=${siteId}`,
      'POST',
      { name: `projects/${activeProjectId}/sites/${siteId}` }
    );

    res.json({
      success: true,
      message: `Sitio "${siteId}" creado con éxito en el proyecto "${activeProjectId}".`,
      site: result
    });
  } catch (err) {
    console.error('Error al crear sitio de hosting:', err.message);
    res.status(500).json({
      error: 'Fallo al crear sitio de Firebase Hosting',
      message: err.message
    });
  }
});

// Vincular dominio personalizado en Firebase Hosting
app.post('/api/hosting/customDomains', async (req, res) => {
  const { siteId, customDomain, projectId } = req.body;

  if (!siteId || !customDomain) {
    return res.status(400).json({ error: 'Los campos "siteId" y "customDomain" son requeridos.' });
  }

  const activeProjectId = resolveActiveProjectId(projectId);
  if (!activeProjectId) {
    return res.status(400).json({
      error: 'ID del proyecto Firebase no definido. Especifícalo en la petición o configura el proyecto por defecto.'
    });
  }

  try {
    const result = await callFirebaseHostingAPI(
      `projects/${activeProjectId}/sites/${siteId}/customDomains?customDomainId=${customDomain}`,
      'POST',
      { name: `projects/${activeProjectId}/sites/${siteId}/customDomains/${customDomain}` }
    );

    res.json({
      success: true,
      message: `Dominio personalizado "${customDomain}" vinculado con éxito al sitio "${siteId}".`,
      customDomain: result
    });
  } catch (err) {
    console.error('Error al vincular dominio personalizado:', err.message);
    res.status(500).json({
      error: 'Fallo al vincular dominio personalizado',
      message: err.message
    });
  }
});

// Desvincular dominio personalizado de un sitio en Firebase Hosting
app.delete('/api/hosting/customDomains', async (req, res) => {
  const { siteId, customDomain, projectId } = req.body;

  if (!siteId || !customDomain) {
    return res.status(400).json({ error: 'Los campos "siteId" y "customDomain" son requeridos.' });
  }

  const activeProjectId = resolveActiveProjectId(projectId);
  if (!activeProjectId) {
    return res.status(400).json({ error: 'ID del proyecto Firebase no definido.' });
  }

  try {
    const result = await callFirebaseHostingAPI(
      `projects/${activeProjectId}/sites/${siteId}/customDomains/${customDomain}`,
      'DELETE'
    );

    res.json({
      success: true,
      message: `Dominio personalizado "${customDomain}" desvinculado con éxito del sitio "${siteId}".`,
      result
    });
  } catch (err) {
    console.error('Error al desvincular dominio personalizado:', err.message);
    res.status(500).json({
      error: 'Fallo al desvincular dominio personalizado',
      message: err.message
    });
  }
});

/**
 * Envía petición de CNAME pasando primero por el API Gateway (con Auto-Wakeup) y con fallback directo al puerto 3400.
 */
async function registerDnsCnameViaGatewayOrDirect(dnsBody) {
  const gatewayPort = Number(process.env.GATEWAY_PORT || 3000);
  const dnsPort = Number(process.env.DOMAIN_MANAGER_PORT || 3400);
  const endpoints = [
    `http://127.0.0.1:${gatewayPort}/api/dns/cname`,
    `http://127.0.0.1:${dnsPort}/api/dns/cname`
  ];

  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dnsBody)
      });
      const data = await response.json();
      if (response.ok && data.success) {
        return { ok: true, data };
      }
      lastError = data.error || data.message || `HTTP ${response.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError || 'No se pudo contactar con el gestor de dominios.' };
}

// Desplegar carpeta a un site multisitio, vincular dominio personalizado y registrar CNAME
app.post('/api/hosting/full-deploy', async (req, res) => {
  const { folderPath, siteId, projectId, customDomain, customSubdomain } = req.body;

  if (!folderPath || !siteId) {
    return res.status(400).json({ error: 'Los campos "folderPath" y "siteId" son requeridos.' });
  }

  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    return res.status(400).json({ error: `La carpeta local especificada no existe: ${resolvedPath}` });
  }

  const activeProjectId = resolveActiveProjectId(projectId);
  if (!activeProjectId) {
    return res.status(400).json({ error: 'ID del proyecto Firebase no definido.' });
  }

  const stepsExecuted = [];

  try {
    // Paso 1: Crear sitio de Firebase Hosting (silencioso si ya existe)
    try {
      await callFirebaseHostingAPI(
        `projects/${activeProjectId}/sites?siteId=${siteId}`,
        'POST',
        { name: `projects/${activeProjectId}/sites/${siteId}` }
      );
      stepsExecuted.push({ step: 'create_site', success: true, message: 'Sitio de Hosting creado con éxito.' });
    } catch (err) {
      if (err.message.includes('ALREADY_EXISTS') || err.message.toLowerCase().includes('already exists') || err.message.includes('409')) {
        stepsExecuted.push({ step: 'create_site', success: true, message: 'El sitio de Hosting ya existía.' });
      } else {
        throw new Error(`Error al crear sitio de Hosting: ${err.message}`);
      }
    }

    // Paso 2: Desplegar archivos al site específico
    try {
      await executeFirebaseHostingDeploy({
        resolvedPath,
        activeProjectId,
        siteId,
        noCacheHeaders: true
      });
      stepsExecuted.push({ step: 'deploy_files', success: true, message: 'Archivos desplegados con éxito.' });
    } catch (err) {
      throw new Error(`Error en el despliegue de archivos: ${err.message}`);
    }

    // Paso 3: Vincular dominio personalizado si se solicita
    let finalDomain = customDomain;
    if (customSubdomain && !finalDomain) {
      const baseDomain = process.env.CLOUDFLARE_BASE_DOMAIN || 'gironacc.com';
      finalDomain = `${customSubdomain}.${baseDomain}`;
    }

    if (finalDomain) {
      try {
        await callFirebaseHostingAPI(
          `projects/${activeProjectId}/sites/${siteId}/customDomains?customDomainId=${finalDomain}`,
          'POST',
          { name: `projects/${activeProjectId}/sites/${siteId}/customDomains/${finalDomain}` }
        );
        stepsExecuted.push({ step: 'link_domain', success: true, message: `Dominio ${finalDomain} vinculado en Firebase.` });
      } catch (err) {
        if (err.message.includes('ALREADY_EXISTS') || err.message.toLowerCase().includes('already exists') || err.message.includes('409')) {
          stepsExecuted.push({ step: 'link_domain', success: true, message: `El dominio ${finalDomain} ya estaba vinculado en Firebase.` });
        } else {
          stepsExecuted.push({ step: 'link_domain', success: false, message: `Aviso: No se pudo vincular el dominio en Firebase: ${err.message}` });
        }
      }

      // Paso 4: Crear registro CNAME vía Gateway centralizado
      if (customSubdomain) {
        const dnsRes = await registerDnsCnameViaGatewayOrDirect({
          name: customSubdomain,
          content: `${siteId}.web.app`,
          proxied: false
        });
        if (dnsRes.ok) {
          stepsExecuted.push({ step: 'create_dns', success: true, message: `CNAME para ${customSubdomain} creado con éxito en Cloudflare (proxied: false).` });
        } else {
          stepsExecuted.push({ step: 'create_dns', success: false, message: `Aviso: No se pudo crear el CNAME en Cloudflare: ${dnsRes.error}` });
        }
      }
    }

    res.json({
      success: true,
      message: 'Flujo de despliegue y automatización de dominios completado.',
      siteId,
      projectId: activeProjectId,
      deployUrl: `https://${siteId}.web.app`,
      customDomain: finalDomain || null,
      steps: stepsExecuted
    });
  } catch (err) {
    console.error('[Full-Deploy Error]', err.message);
    res.status(500).json({
      success: false,
      error: 'Error en el flujo atómico de despliegue',
      message: err.message,
      steps: stepsExecuted
    });
  }
});

// --- Endpoint de Workflow Multi-paso ---

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
        results.push({ step: stepIndex, action, success: true });
      } else if (action === 'hosting.deploy') {
        const { folderPath, projectId } = step;
        if (!folderPath) {
          throw new Error('Falta el campo "folderPath" para hosting.deploy');
        }

        const resolvedPath = path.resolve(folderPath);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`La carpeta local especificada no existe: ${resolvedPath}`);
        }

        const activeProjectId = resolveActiveProjectId(projectId);
        if (!activeProjectId) {
          throw new Error('ID del proyecto Firebase no definido para el deploy.');
        }

        const { deployUrl } = await executeFirebaseHostingDeploy({
          resolvedPath,
          activeProjectId
        });

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
      results.push({
        step: stepIndex,
        action,
        success: false,
        error: err.message
      });
      errorOccurred = true;
      break;
    }
  }

  res.status(errorOccurred ? 500 : 200).json({
    success: !errorOccurred,
    results
  });
});

let serverInstance = null;

app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de Firebase...');
  setTimeout(() => {
    cleanupTempCredentials();
    if (serverInstance) serverInstance.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  }, 300);
});

app.use((err, _req, res, next) => {
  if (err && err.status === 403) {
    return res.status(403).json({ ok: false, error: 'CORS_BLOCKED', message: err.message });
  }
  return next(err);
});

if (process.env.NODE_ENV !== 'test') {
  serverInstance = app.listen(PORT, LOCAL_HOST, () => {
    console.log('=================================================');
    console.log(` Firebase Automation Service corriendo en: http://${LOCAL_HOST}:${PORT}`);
    console.log('=================================================');
  });
}

module.exports = { app };
