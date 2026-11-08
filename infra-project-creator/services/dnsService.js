const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { BASE_PROYECTOS_DIR } = require('../config/env');

const DOMINIOS_API_PORT = process.env.DOMAIN_MANAGER_PORT || 3400;
const DOMINIOS_API_URL = `http://localhost:${DOMINIOS_API_PORT}`;

/**
 * Asegura que la API de gestion-dominios esté levantada localmente.
 * Si no responde, intenta spawnear el proceso de forma independiente.
 */
function ensureDominiosRunning() {
  return new Promise((resolve) => {
    if (process.env.NODE_ENV === 'test') {
      return resolve(false);
    }
    const req = http.get(`${DOMINIOS_API_URL}/ping`, (res) => {
      resolve(true);
    });
    
    req.on('error', () => {
      console.log('Iniciando gestion-dominios...');
      const serverPath = path.resolve(__dirname, '..', '..', 'infra-domain-manager');
      
      const process = spawn('node', ['server.js'], {
        cwd: serverPath,
        detached: true,
        stdio: 'ignore',
        shell: true
      });
      process.unref();
      
      // Esperar un momento a que levante el servidor
      setTimeout(() => resolve(true), 2500);
    });
    
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Realiza una llamada HTTP genérica a la API de gestion-dominios
 */
function callDominiosAPI(endpoint, method, bodyObj = null) {
  return new Promise((resolve) => {
    if (process.env.NODE_ENV === 'test') {
      // Mockear respuestas estándar en entorno de test
      if (endpoint === '/api/dns/records') {
        return resolve({ success: true, records: [] });
      }
      return resolve({ success: true });
    }
    const postData = bodyObj ? JSON.stringify(bodyObj) : '';
    const options = {
      hostname: 'localhost',
      port: DOMINIOS_API_PORT,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyObj && method !== 'GET' ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ success: false, error: 'Error al parsear JSON de Dominios: ' + e.message });
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ success: false, error: e.message });
    });
    
    if (bodyObj && method !== 'GET') {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Crea un subdominio CNAME para un nuevo proyecto
 */
async function createProjectCNAME(projectName, activeJobs, jobId, options = {}) {
  const timestamp = () => new Date().toLocaleTimeString();
  const log = (msg) => {
    if (activeJobs[jobId]) {
      activeJobs[jobId].logs.push(`[${timestamp()}] ${msg}`);
    }
  };

  const {
    hostingType = 'github',
    firebaseSiteId = null
  } = options;

  const content = hostingType === 'firebase'
    ? `${firebaseSiteId || projectName.toLowerCase().replace(/\s+/g, '-')}.web.app`
    : 'joeljuana.github.io';

  const proxied = hostingType !== 'firebase';

  try {
    log(`Registrando subdominio CNAME en Cloudflare para ${hostingType}...`);
    await ensureDominiosRunning();
    
    const dnsRes = await callDominiosAPI('/api/dns/cname', 'POST', {
      name: projectName.toLowerCase().replace(/\s+/g, '-'),
      content: content,
      proxied: proxied
    });
    
    if (dnsRes.success) {
      log(`✓ Subdominio CNAME creado con éxito: ${dnsRes.record.name} -> ${dnsRes.record.content} (${dnsRes.isSimulated ? 'Simulado' : 'Real en Cloudflare'})`);
      return true;
    } else {
      log(`⚠️ Advertencia: No se pudo crear el subdominio CNAME: ${dnsRes.error}`);
      return false;
    }
  } catch (e) {
    log(`⚠️ Error al intentar conectar con la API de Dominios: ${e.message}`);
    return false;
  }
}

/**
 * Actualiza el subdominio CNAME al renombrar un proyecto (elimina el antiguo y crea uno nuevo)
 */
async function updateProjectCNAME(oldName, newName) {
  await ensureDominiosRunning();
  
  const cleanOld = oldName.toLowerCase().replace(/\s+/g, '-');
  const cleanNew = newName.toLowerCase().replace(/\s+/g, '-');
  
  // 1. Obtener registros DNS para buscar el ID del subdominio viejo
  const dnsRecordsRes = await callDominiosAPI('/api/dns/records', 'GET');
  let oldRecordId = null;
  let oldRecordContent = 'joeljuana.github.io';
  let oldRecordProxied = true;
  
  if (dnsRecordsRes.success && dnsRecordsRes.records) {
    const matchRecord = dnsRecordsRes.records.find(r => r.name.startsWith(cleanOld + '.'));
    if (matchRecord) {
      oldRecordId = matchRecord.id;
      oldRecordContent = matchRecord.content;
      oldRecordProxied = matchRecord.proxied !== undefined ? matchRecord.proxied : !oldRecordContent.endsWith('.web.app');
    }
  }
  
  // 2. Eliminar el registro DNS viejo si existe
  let deleteMsg = 'No se requería eliminar subdominio antiguo (no encontrado).';
  if (oldRecordId) {
    const delRes = await callDominiosAPI(`/api/dns/records/${oldRecordId}`, 'DELETE');
    if (delRes.success) {
      deleteMsg = `Subdominio antiguo '${cleanOld}' eliminado.`;
    } else {
      deleteMsg = `Advertencia: no se pudo eliminar subdominio antiguo: ${delRes.error}`;
    }
  }
  
  // 3. Crear el nuevo registro DNS CNAME preservando configuración de proxy
  const createRes = await callDominiosAPI('/api/dns/cname', 'POST', {
    name: cleanNew,
    content: oldRecordContent,
    proxied: oldRecordProxied
  });
  
  let createMsg = '';
  if (createRes.success) {
    createMsg = `Subdominio nuevo '${cleanNew}' creado con éxito.`;
  } else {
    createMsg = `Advertencia: no se pudo crear el subdominio nuevo: ${createRes.error}`;
  }
  
  return {
    deleted: deleteMsg,
    created: createMsg
  };
}

/**
 * Elimina el subdominio CNAME correspondiente a un proyecto
 */
async function deleteProjectCNAME(projectName) {
  await ensureDominiosRunning();
  
  const cleanName = projectName.toLowerCase().replace(/\s+/g, '-');
  
  // 1. Buscar el registro DNS
  const dnsRecordsRes = await callDominiosAPI('/api/dns/records', 'GET');
  let recordId = null;
  
  if (dnsRecordsRes.success && dnsRecordsRes.records) {
    const matchRecord = dnsRecordsRes.records.find(r => r.name.startsWith(cleanName + '.'));
    if (matchRecord) {
      recordId = matchRecord.id;
    }
  }
  
  // 2. Eliminar si se encuentra
  if (recordId) {
    const delRes = await callDominiosAPI(`/api/dns/records/${recordId}`, 'DELETE');
    if (delRes.success) {
      return `Subdominio '${cleanName}' eliminado con éxito.`;
    } else {
      return `Advertencia: no se pudo eliminar el subdominio: ${delRes.error}`;
    }
  }
  
  return `No se requería eliminar el subdominio '${cleanName}' (no encontrado).`;
}

module.exports = {
  ensureDominiosRunning,
  callDominiosAPI,
  createProjectCNAME,
  updateProjectCNAME,
  deleteProjectCNAME
};
