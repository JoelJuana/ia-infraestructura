const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const {
  LOCAL_HOST,
  createLocalCorsOptions,
  localSecurityMiddleware,
  writeEnvFileSafe,
  getProcessMetrics
} = require('../packages/shared/index.cjs');

// Cargar únicamente el archivo .env propio del microservicio (sin copiar secretos ajenos)
const localEnvPath = path.join(__dirname, '.env');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else {
  dotenv.config();
}

const app = express();
const PORT = Number(process.env.PORT || process.env.DOMAIN_MANAGER_PORT || process.env.CLOUDFLARE_PORT || 3400);

app.use(localSecurityMiddleware);
app.use(cors(createLocalCorsOptions()));
app.use(express.json());
app.use((req, _res, next) => {
  // Normalizar rutas cuando entran por el API Gateway (/api/dns/cname -> /api/dns/cname o /api/config)
  if (req.url !== '/' && !req.url.startsWith('/ping') && !req.url.startsWith('/api/')) {
    if (req.url.startsWith('/records') || req.url.startsWith('/cname')) {
      req.url = `/api/dns${req.url}`;
    } else {
      req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
  }
  next();
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'infra-domain-manager',
    port: PORT,
    status: 'online'
  });
});

function writeEnvFile(vars) {
  writeEnvFileSafe(localEnvPath, vars);
}

// --- SISTEMA DE ENCRIPTACIÓN AUTENTICADA DE CREDENCIALES (AES-256-GCM + retrocompatibilidad CBC) ---
const GCM_ALGORITHM = 'aes-256-gcm';
const LEGACY_CBC_ALGORITHM = 'aes-256-cbc';

function getEncryptionKey() {
  let key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    const generatedKey = crypto.randomBytes(32).toString('hex');
    writeEnvFile({ ENCRYPTION_KEY: generatedKey });
    key = generatedKey;
  }
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `gcm:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(text) {
  if (!text) return '';
  if (!text.includes(':')) return text;

  try {
    const key = getEncryptionKey();

    // Formato autenticado AES-256-GCM: gcm:<iv>:<authTag>:<cipher>
    if (text.startsWith('gcm:')) {
      const [, ivHex, tagHex, cipherHex] = text.split(':');
      const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      let decrypted = decipher.update(Buffer.from(cipherHex, 'hex'), undefined, 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    // Formato legacy AES-256-CBC: <iv>:<cipher>
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(LEGACY_CBC_ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Error al desencriptar credencial:', err.message);
    return '';
  }
}

function maskString(str) {
  if (!str) return '';
  if (str.length <= 8) return '...';
  return `${str.substring(0, 4)}...${str.substring(str.length - 4)}`;
}

// --- ENDPOINTS ---

app.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'infra-domain-manager',
    port: PORT,
    ...getProcessMetrics()
  });
});

app.get('/api/config', (_req, res) => {
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  res.json({
    hasToken: !!token,
    maskedToken: maskString(token),
    zoneId: process.env.CLOUDFLARE_ZONE_ID || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    baseDomain: process.env.CLOUDFLARE_BASE_DOMAIN || ''
  });
});

app.post('/api/config', (req, res) => {
  const { token, zoneId, accountId, baseDomain } = req.body;

  try {
    const varsToUpdate = {};
    if (token !== undefined && !token.includes('...')) {
      varsToUpdate.CLOUDFLARE_API_TOKEN = encrypt(token);
    }
    if (zoneId !== undefined) varsToUpdate.CLOUDFLARE_ZONE_ID = zoneId;
    if (accountId !== undefined) varsToUpdate.CLOUDFLARE_ACCOUNT_ID = accountId;
    if (baseDomain !== undefined) varsToUpdate.CLOUDFLARE_BASE_DOMAIN = baseDomain;

    writeEnvFile(varsToUpdate);
    res.json({ success: true, message: 'Configuración guardada correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1. Validar disponibilidad y precio de nombres de dominio
app.get('/api/domains/check', async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ success: false, error: 'Debe especificar un dominio a validar.' });
  }

  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token || !accountId) {
    return res.json({
      success: true,
      isSimulated: true,
      message: 'Mostrando datos simulados por falta de credenciales de Cloudflare.',
      result: {
        domain,
        available: true,
        purchase_price: '$10.99',
        renewal_price: '$10.99',
        supported_tld: true
      }
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: domain,
          exclude_disallowed: true
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      const errorMsg = data.errors && data.errors[0] ? data.errors[0].message : 'Error desconocido en Cloudflare';
      console.warn('Error en llamada real de Cloudflare Registrar:', errorMsg);

      const cleanDomain = String(domain).toLowerCase().trim();
      const isAvailable = !cleanDomain.includes('google') && !cleanDomain.includes('cloudflare') && !cleanDomain.includes('github');

      return res.json({
        success: true,
        isSimulated: true,
        message: `API Real reportó: "${errorMsg}". Mostrando simulación de disponibilidad.`,
        result: {
          domain,
          available: isAvailable,
          purchase_price: '$12.50 USD',
          renewal_price: '$12.50 USD',
          supported_tld: cleanDomain.endsWith('.com') || cleanDomain.endsWith('.net') || cleanDomain.endsWith('.org') || cleanDomain.endsWith('.dev')
        }
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      result: data.result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Obtener todos los registros DNS de la zona
app.get('/api/dns/records', async (_req, res) => {
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!token || !zoneId) {
    return res.json({
      success: true,
      isSimulated: true,
      message: 'Variables de entorno incompletas (requiere CLOUDFLARE_API_TOKEN y CLOUDFLARE_ZONE_ID).',
      records: [
        {
          id: 'sim-1',
          type: 'CNAME',
          name: `ejemplo.${process.env.CLOUDFLARE_BASE_DOMAIN || 'tus-proyectos.com'}`,
          content: 'joeljuana.github.io',
          proxied: true,
          ttl: 1,
          locked: false
        }
      ]
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : 'Error al obtener DNS de Cloudflare'
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      records: data.result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Crear registro DNS de tipo CNAME
app.post('/api/dns/cname', async (req, res) => {
  const { name, content, proxied } = req.body;
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const baseDomain = process.env.CLOUDFLARE_BASE_DOMAIN || 'tus-proyectos.com';

  if (!name || !content) {
    return res.status(400).json({ success: false, error: "Los campos 'name' y 'content' son obligatorios." });
  }

  let fullRecordName = name;
  if (!name.endsWith(baseDomain)) {
    fullRecordName = `${name}.${baseDomain}`;
  }

  if (!token || !zoneId) {
    return res.json({
      success: true,
      isSimulated: true,
      message: 'Registro creado en modo simulación (credenciales incompletas).',
      record: {
        id: `sim-${Date.now()}`,
        type: 'CNAME',
        name: fullRecordName,
        content,
        proxied: proxied !== false,
        ttl: 1
      }
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: fullRecordName,
          content,
          ttl: 1,
          proxied: proxied !== false
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : 'Error al crear registro DNS'
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      record: data.result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Eliminar registro DNS
app.delete('/api/dns/records/:id', async (req, res) => {
  const { id } = req.params;
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (id.startsWith('sim-')) {
    return res.json({
      success: true,
      isSimulated: true,
      message: 'Registro simulado eliminado del listado local.'
    });
  }

  if (!token || !zoneId) {
    return res.status(400).json({ success: false, error: 'Faltan credenciales de Cloudflare para eliminar registros.' });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : 'Error al eliminar registro DNS'
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      message: 'Registro DNS eliminado correctamente.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

let serverInstance = null;

app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor...');
  setTimeout(() => {
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
    console.log(`\n======================================================`);
    console.log(`Gestión Dominios corriendo en: http://${LOCAL_HOST}:${PORT}`);
    console.log(`======================================================\n`);
  });
}

module.exports = { app, encrypt, decrypt };
