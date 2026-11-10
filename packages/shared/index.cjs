'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const LOCAL_HOST = process.env.BIND_HOST || '127.0.0.1';

const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Comprueba si un encabezado Origin pertenece estrictamente a la máquina local.
 */
function isAllowedLocalOrigin(origin) {
  if (!origin) return true; // Peticiones server-to-server, CLI, curl o agentes locales
  return LOCAL_ORIGIN_REGEX.test(origin);
}

/**
 * Devuelve las opciones de configuración para el middleware `cors` restringidas a localhost.
 */
function createLocalCorsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedLocalOrigin(origin)) {
        return callback(null, true);
      }
      const err = new Error('Origen CORS bloqueado por política de seguridad local.');
      err.status = 403;
      return callback(err, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  };
}

/**
 * Middleware que bloquea peticiones mutadoras originadas desde sitios web remotos en el navegador (anti-CSRF/DNS Rebinding).
 */
function localSecurityMiddleware(req, res, next) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  if (hostHeader && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostHeader)) {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN_HOST',
      message: 'Host no autorizado. Los microservicios locales solo aceptan conexiones dirigidas a localhost/127.0.0.1.'
    });
  }

  const origin = req.headers.origin;
  if (origin && !isAllowedLocalOrigin(origin)) {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN_ORIGIN',
      message: 'Origen externo bloqueado por seguridad local.'
    });
  }

  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site' && !isAllowedLocalOrigin(origin || '')) {
    return res.status(403).json({
      ok: false,
      error: 'CROSS_SITE_BLOCKED',
      message: 'Petición cross-site bloqueada.'
    });
  }

  return next();
}

/**
 * Actualiza de forma atómica un archivo .env preservando claves existentes y sincronizando process.env.
 */
function writeEnvFileSafe(envPath, varsToUpdate) {
  const currentEnv = {};
  const preservedLines = [];
  const seenKeys = new Set();

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of envContent.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        preservedLines.push({ type: 'raw', text: rawLine });
        continue;
      }
      const eqIdx = rawLine.indexOf('=');
      if (eqIdx > 0) {
        const key = rawLine.slice(0, eqIdx).trim();
        const val = rawLine.slice(eqIdx + 1).trim();
        currentEnv[key] = val;
        preservedLines.push({ type: 'kv', key });
        seenKeys.add(key);
      }
    }
  }

  const merged = { ...currentEnv, ...varsToUpdate };
  const outputLines = [];

  for (const item of preservedLines) {
    if (item.type === 'raw') {
      outputLines.push(item.text);
    } else if (Object.prototype.hasOwnProperty.call(merged, item.key)) {
      outputLines.push(`${item.key}=${merged[item.key]}`);
    }
  }

  for (const [k, v] of Object.entries(merged)) {
    if (!seenKeys.has(k)) {
      outputLines.push(`${k}=${v}`);
    }
  }

  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${envPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, outputLines.join('\n').trimEnd() + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, envPath);

  for (const [k, v] of Object.entries(varsToUpdate)) {
    process.env[k] = String(v);
  }
}

/**
 * Obtiene métricas ligeras de memoria y tiempo activo del proceso actual.
 */
function getProcessMetrics() {
  return {
    memoryMB: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    uptimeSeconds: Math.floor(process.uptime())
  };
}

/**
 * Verifica si una dirección IPv4 o IPv6 pertenece a rangos privados, loopback, link-local o reservados.
 */
function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const normalized = ip.trim().toLowerCase();

  // IPv4 mapeada en IPv6 (ej. ::ffff:127.0.0.1)
  if (normalized.startsWith('::ffff:')) {
    const mappedV4 = normalized.slice(7);
    if (net.isIPv4(mappedV4)) {
      return isPrivateOrReservedIp(mappedV4);
    }
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                             // 0.0.0.0/8
    if (a === 10) return true;                            // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true;                           // 127.0.0.0/8 (Loopback)
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (Link-local / Cloud Metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16 (RFC1918)
    if (a >= 224) return true;                            // Multicast / Reservadas
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique Local (fc00::/7)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // Link-local (fe80::/10)
    }
    return false;
  }

  return true;
}

/**
 * Valida que una URL sea HTTP/HTTPS pública y no apunte a localhost ni redes internas (anti-SSRF).
 */
async function validateSafeExternalUrl(rawUrl, options = {}) {
  const { resolveDns = true } = options;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'La URL es obligatoria.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Formato de URL inválido.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Solo se permiten protocolos http: o https:.' };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { safe: false, reason: 'El acceso a hosts locales o internos está bloqueado por seguridad (anti-SSRF).' };
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { safe: false, reason: 'El acceso a direcciones IP privadas o loopback está bloqueado (anti-SSRF).' };
    }
    return { safe: true, parsedUrl: parsed };
  }

  if (resolveDns) {
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      if (!records || records.length === 0) {
        return { safe: false, reason: `No se pudo resolver el dominio: ${hostname}` };
      }
      for (const rec of records) {
        if (isPrivateOrReservedIp(rec.address)) {
          return { safe: false, reason: `El dominio ${hostname} resuelve a una IP privada o local bloqueada (${rec.address}).` };
        }
      }
    } catch (err) {
      return { safe: false, reason: `Error de resolución DNS para ${hostname}: ${err.message}` };
    }
  }

  return { safe: true, parsedUrl: parsed };
}

/**
 * Lee los últimos bytes/líneas de un archivo de log sin cargar archivos grandes enteros en RAM.
 */
function readLogTail(filePath, maxLines = 250, maxBytes = 65536) {
  if (!fs.existsSync(filePath)) return null;
  let fd = null;
  try {
    const stats = fs.statSync(filePath);
    if (stats.size === 0) return '';

    const bytesToRead = Math.min(stats.size, maxBytes);
    const startOffset = stats.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);

    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, bytesToRead, startOffset);

    let text = buffer.toString('utf8');
    if (startOffset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
    }

    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.slice(-maxLines).join('\n');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  LOCAL_HOST,
  isAllowedLocalOrigin,
  createLocalCorsOptions,
  localSecurityMiddleware,
  writeEnvFileSafe,
  getProcessMetrics,
  isPrivateOrReservedIp,
  validateSafeExternalUrl,
  readLogTail
};
