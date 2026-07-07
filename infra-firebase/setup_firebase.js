/* eslint-disable */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Cargar variables de entorno si existen
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config();
  console.log('✓ Archivo .env local cargado.');
} else {
  console.log('ℹ No se encontró archivo .env local. Se usarán valores predeterminados.');
}

async function run() {
  console.log('\n--- DIAGNÓSTICO DE AUTOMATIZACIÓN DE FIREBASE ---\n');

  // 1. Detectar archivos de configuración
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'serviceAccountKey.json');
  const firebasercPath = path.join(__dirname, '.firebaserc');

  let defaultProjectId = '';
  if (fs.existsSync(firebasercPath)) {
    try {
      const rc = JSON.parse(fs.readFileSync(firebasercPath, 'utf8'));
      defaultProjectId = rc.projects?.default || '';
      console.log(`✓ Archivo .firebaserc detectado. Proyecto por defecto: "${defaultProjectId}"`);
    } catch (err) {
      console.warn('⚠️ Error al leer .firebaserc:', err.message);
    }
  }

  // 2. Determinar método de inicialización
  let credential = null;
  let projectId = '';
  let clientEmail = '';

  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      credential = admin.credential.cert(serviceAccount);
      projectId = serviceAccount.project_id;
      clientEmail = serviceAccount.client_email;
      console.log(`✓ Encontrado archivo de Service Account en: ${serviceAccountPath}`);
    } catch (err) {
      console.error('❌ Error al parsear serviceAccountKey.json:', err.message);
    }
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    try {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      });
      projectId = process.env.FIREBASE_PROJECT_ID;
      clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      console.log('✓ Detectadas credenciales individuales en variables de entorno.');
    } catch (err) {
      console.error('❌ Error al procesar credenciales de variables de entorno:', err.message);
    }
  }

  if (!credential) {
    console.log('\n❌ DIAGNÓSTICO: NO CONFIGURADO');
    console.log(
      'Para habilitar la API, por favor coloca tu "serviceAccountKey.json" en este directorio'
    );
    console.log('o bien configura las variables de entorno en un archivo .env:');
    console.log('  FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    process.exit(1);
  }

  // 3. Conectar a Firebase
  console.log(`Conectando a Firebase Project: "${projectId}"...`);
  try {
    admin.initializeApp({
      credential,
      projectId
    });
    console.log('✓ SDK de Firebase Admin inicializado.');
  } catch (err) {
    console.error('❌ Error al inicializar Firebase Admin App:', err.message);
    process.exit(1);
  }

  // 4. Probar Firestore
  console.log('\nProbando acceso a Firestore...');
  try {
    const db = admin.firestore();
    const collections = await db.listCollections();
    console.log(
      `✓ Firestore conectado. Colecciones raíz encontradas: [${collections.map(c => c.id).join(', ')}]`
    );
  } catch (err) {
    console.warn(
      '⚠️ Advertencia al conectar a Firestore (¿las reglas lo bloquean o la API no está activa?):',
      err.message
    );
  }

  // 5. Probar Auth
  console.log('Probando acceso a Firebase Auth...');
  try {
    const authList = await admin.auth().listUsers(1);
    console.log(
      `✓ Firebase Auth conectado. Usuarios en el proyecto: ${authList.users.length > 0 ? 'Sí (existen)' : '0 usuarios registrados'}`
    );
  } catch (err) {
    console.warn('⚠️ Advertencia al conectar a Firebase Auth:', err.message);
  }

  // 6. Actualizar .env con los datos del proyecto
  console.log('\nActualizando variables en archivo .env local...');
  try {
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split('\n');
    const newLines = [];
    const vars = {
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_CLIENT_EMAIL: clientEmail,
      PORT: '4001'
    };

    const processed = new Set();
    lines.forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        if (vars[key] !== undefined) {
          newLines.push(`${key}=${vars[key]}`);
          processed.add(key);
          return;
        }
      }
      newLines.push(line);
    });

    Object.entries(vars).forEach(([k, v]) => {
      if (!processed.has(k)) {
        newLines.push(`${k}=${v}`);
      }
    });

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
    console.log('✓ Archivo .env local sincronizado y configurado.');
  } catch (err) {
    console.error('❌ Error al actualizar el archivo .env:', err.message);
  }

  console.log('\n🎉 ¡DIAGNÓSTICO Y CONFIGURACIÓN COMPLETADOS CON ÉXITO! 🎉\n');
}

run().catch(err => {
  console.error('❌ Error fatal en el proceso de setup:', err.message);
  process.exit(1);
});
