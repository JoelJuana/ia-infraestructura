/* ==========================================================================
   DASHBOARD LOGIC - PROYECTOS IA
   ========================================================================== */

// Nombre descriptivo de servicios
const SERVICES_METADATA = {
  'infra-github': {
    title: 'Servicio GitHub Integration',
    desc: 'Administración de repositorios y sincronización de contenido para GitPublish.'
  },
  'infra-firebase': {
    title: 'Servicio Firebase local',
    desc: 'Acceso a Firestore, autenticación y despliegues automáticos rápidos.'
  },
  'infra-project-creator': {
    title: 'Creador de Proyectos',
    desc: 'Inicializador estructurado para nuevos repositorios y servicios locales.'
  },
  'infra-domain-manager': {
    title: 'Gestor de Dominios (Cloudflare)',
    desc: 'Automatización de DNS y creación de subdominios CNAME mediante API.'
  },
  'api-design-assets': {
    title: 'API de Diseño & Assets',
    desc: 'Generador de paletas premium, tipografías y plantillas HTML/CSS de mockups.'
  },
  'api-conocimiento-rag': {
    title: 'Base de Conocimiento RAG',
    desc: 'Motor de indexación, fragmentación y búsqueda semántica de documentos local.'
  },
  'api-utilidades-scraping': {
    title: 'Extractor Web (Scraping)',
    desc: 'Limpieza y extracción no intrusiva de texto web estructurado en Markdown.'
  },
  'infra-gateway': {
    title: 'API Gateway Central',
    desc: 'Enrutador central de tráfico, logs unificados y salud del monorepositorio.'
  }
};

// Configuración global de polling
const POLL_INTERVAL_HEALTH = 5000; // 5 segundos
const POLL_INTERVAL_LOGS = 3000;   // 3 segundos

let currentSelectedService = null;
let healthIntervalId = null;
let logsIntervalId = null;

// Modal confirmación
let pendingAction = null;
let pendingService = null;

// Elementos del DOM
const servicesContainer = document.getElementById('services-container');
const suiteHealthText = document.getElementById('suite-health-text');
const suiteHealthPulse = document.getElementById('suite-health-pulse');
const suiteHealthBox = document.getElementById('suite-health-box');
const orchestratorVal = document.getElementById('orchestrator-val');
const btnRefreshAll = document.getElementById('btn-refresh-all');

const activeLogTitle = document.getElementById('active-log-title');
const btnRefreshLogs = document.getElementById('btn-refresh-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');
const terminalContent = document.getElementById('terminal-content');

const confirmModal = document.getElementById('confirm-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelModal = document.getElementById('btn-cancel-modal');
const btnConfirmModal = document.getElementById('btn-confirm-modal');
const modalBodyText = document.getElementById('modal-body-text');

/* ==========================================================================
   FUNCIONES DE INICIALIZACIÓN
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  fetchHealth();
  
  // Iniciar Polling de salud
  healthIntervalId = setInterval(fetchHealth, POLL_INTERVAL_HEALTH);
  
  // Event listeners
  btnRefreshAll.addEventListener('click', () => {
    btnRefreshAll.classList.add('fa-spin');
    fetchHealth().finally(() => {
      setTimeout(() => btnRefreshAll.classList.remove('fa-spin'), 600);
    });
  });

  btnRefreshLogs.addEventListener('click', () => {
    if (currentSelectedService) {
      fetchLogs(currentSelectedService);
    }
  });

  btnClearLogs.addEventListener('click', () => {
    terminalContent.innerText = '';
  });

  // Modal close handlers
  btnCloseModal.addEventListener('click', hideModal);
  btnCancelModal.addEventListener('click', hideModal);
  btnConfirmModal.addEventListener('click', executePendingAction);

  // Cerrar modal al hacer clic fuera
  window.addEventListener('click', (e) => {
    if (e.target === confirmModal) hideModal();
  });
});

/* ==========================================================================
   PETICIONES API - SALUD DE LOS SERVICIOS
   ========================================================================== */
async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Error al conectar con el Gateway.');
    
    const result = await res.json();
    if (result.ok && result.data) {
      updateUI(result.data);
    }
  } catch (err) {
    console.error(err);
    suiteHealthText.innerText = 'Desconectado';
    suiteHealthPulse.className = 'pulse-dot red';
    suiteHealthBox.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    servicesContainer.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dark);">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 36px; color: var(--color-offline); margin-bottom: 12px;"></i>
        <p>No se pudo conectar con el Gateway central. Asegúrate de que el puerto 3000 esté activo.</p>
      </div>
    `;
  }
}

function updateUI(data) {
  // 1. Actualizar estado global
  const status = data.overallStatus;
  orchestratorVal.innerText = data.orchestrator.toUpperCase();
  
  if (status === 'healthy') {
    suiteHealthText.innerText = 'SALUDABLE';
    suiteHealthPulse.className = 'pulse-dot green';
    suiteHealthBox.style.borderColor = 'rgba(16, 185, 129, 0.3)';
  } else if (status === 'degraded') {
    suiteHealthText.innerText = 'DEGRADADO';
    suiteHealthPulse.className = 'pulse-dot orange';
    suiteHealthBox.style.borderColor = 'rgba(245, 158, 11, 0.3)';
  } else {
    suiteHealthText.innerText = 'FALLO GENERAL';
    suiteHealthPulse.className = 'pulse-dot red';
    suiteHealthBox.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }

  // 2. Generar grilla de servicios
  const services = Object.values(data.services);
  
  // Agregar Gateway a la lista de forma visual para monitoreo (aunque siempre está online para ver esta pantalla)
  const gwService = {
    name: 'infra-gateway',
    url: `http://localhost:3000`,
    status: 'online',
    latencyMs: 1,
    envExists: true,
    isGateway: true
  };
  
  const allServices = [...services, gwService];
  
  servicesContainer.innerHTML = '';
  
  allServices.forEach(svc => {
    const meta = SERVICES_METADATA[svc.name] || { title: svc.name, desc: 'Servicio de la suite.' };
    const isOnline = svc.status === 'online';
    const isDegraded = svc.status === 'degraded';
    
    let statusClass = 'offline';
    if (isOnline) statusClass = 'online';
    if (isDegraded) statusClass = 'degraded';
    
    // Badge de latencia
    let latencyHTML = '';
    if (isOnline && svc.latencyMs !== null) {
      const isSlow = svc.latencyMs > 150;
      latencyHTML = `
        <span class="meta-badge latency ${isSlow ? 'slow' : ''}">
          <i class="fa-solid fa-gauge-high"></i> ${svc.latencyMs} ms
        </span>
      `;
    }

    // Badge de variable de entorno (.env)
    let envHTML = '';
    const servicesWithOptionalEnv = [
      'infra-gateway',
      'infra-project-creator',
      'api-design-assets',
      'api-conocimiento-rag',
      'api-utilidades-scraping'
    ];
    if (!servicesWithOptionalEnv.includes(svc.name)) {
      if (svc.envExists) {
        envHTML = `<span class="meta-badge env-ok"><i class="fa-solid fa-circle-check"></i> .env configurado</span>`;
      } else {
        envHTML = `<span class="meta-badge env-warn" title="Falta crear el archivo .env en su subcarpeta para que funcione correctamente"><i class="fa-solid fa-circle-exclamation"></i> sin .env</span>`;
      }
    }

    // Botones de acción
    let actionButtons = '';
    if (svc.isGateway) {
      actionButtons = `
        <button class="btn btn-secondary btn-logs ${currentSelectedService === svc.name ? 'active' : ''}" onclick="selectServiceLogs('${svc.name}')">
          <i class="fa-solid fa-receipt"></i> Logs
        </button>
      `;
    } else {
      const isPending = pendingService === svc.name;
      const startBtn = `
        <button class="btn btn-start" ${isPending ? 'disabled' : ''} onclick="startService('${svc.name}')">
          ${isPending && pendingAction === 'start' ? '<i class="fa-solid fa-circle-notch spinner"></i>' : '<i class="fa-solid fa-play"></i>'} Arrancar
        </button>
      `;
      const stopBtn = `
        <button class="btn btn-stop" ${isPending ? 'disabled' : ''} onclick="promptStopService('${svc.name}')">
          ${isPending && pendingAction === 'stop' ? '<i class="fa-solid fa-circle-notch spinner"></i>' : '<i class="fa-solid fa-stop"></i>'} Detener
        </button>
      `;
      
      actionButtons = `
        ${isOnline || isDegraded ? stopBtn : startBtn}
        <button class="btn btn-secondary btn-logs ${currentSelectedService === svc.name ? 'active' : ''}" onclick="selectServiceLogs('${svc.name}')">
          <i class="fa-solid fa-receipt"></i> Logs
        </button>
      `;
    }

    const card = document.createElement('div');
    card.className = `service-card ${statusClass}`;
    card.innerHTML = `
      <div class="service-info">
        <div class="service-title-row">
          <span class="service-name">${meta.title}</span>
          <span class="service-port">${svc.url.split(':').pop() || '3000'}</span>
        </div>
        <p class="service-desc">${meta.desc}</p>
        <div class="service-meta-row">
          ${latencyHTML}
          ${envHTML}
        </div>
      </div>
      <div class="service-actions">
        ${actionButtons}
      </div>
    `;
    servicesContainer.appendChild(card);
  });
}

/* ==========================================================================
   CONTROL DE SERVICIOS (START/STOP)
   ========================================================================== */
async function startService(serviceName) {
  pendingAction = 'start';
  pendingService = serviceName;
  fetchHealth(); // Actualizar UI para mostrar spinner
  
  try {
    const res = await fetch(`/api/gateway/services/${serviceName}/start`, { method: 'POST' });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || 'Error al iniciar servicio.');
    
    // Autocargar logs tras arrancar
    selectServiceLogs(serviceName);
  } catch (err) {
    alert(`No se pudo arrancar el servicio: ${err.message}`);
  } finally {
    pendingAction = null;
    pendingService = null;
    fetchHealth();
  }
}

function promptStopService(serviceName) {
  pendingAction = 'stop';
  pendingService = serviceName;
  modalBodyText.innerHTML = `¿Estás seguro de que deseas detener el servicio <strong>${SERVICES_METADATA[serviceName].title}</strong>? Esto cortará el acceso del monorepositorio a esta API local.`;
  showModal();
}

async function executePendingAction() {
  hideModal();
  if (pendingAction !== 'stop' || !pendingService) return;
  
  const serviceName = pendingService;
  fetchHealth(); // Mostrar spinner
  
  try {
    const res = await fetch(`/api/gateway/services/${serviceName}/stop`, { method: 'POST' });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || 'Error al detener servicio.');
  } catch (err) {
    alert(`No se pudo detener el servicio: ${err.message}`);
  } finally {
    pendingAction = null;
    pendingService = null;
    fetchHealth();
  }
}

/* ==========================================================================
   GESTIÓN DE LOGS (TERMINAL VIRTUAL)
   ========================================================================== */
function selectServiceLogs(serviceName) {
  currentSelectedService = serviceName;
  activeLogTitle.innerText = serviceName;
  terminalContent.innerText = `Cargando logs de ${serviceName}...`;
  
  // Limpiar polling previo
  if (logsIntervalId) clearInterval(logsIntervalId);
  
  // Carga inmediata
  fetchLogs(serviceName);
  
  // Configurar polling de logs
  logsIntervalId = setInterval(() => fetchLogs(serviceName), POLL_INTERVAL_LOGS);
  
  // Refrescar estado para activar el botón en la tarjeta
  fetchHealth();
}

async function fetchLogs(serviceName) {
  try {
    const res = await fetch(`/api/gateway/logs/${serviceName}`);
    if (!res.ok) throw new Error('Error al obtener logs.');
    
    const result = await res.json();
    if (result.ok) {
      const isAtBottom = terminalContent.scrollHeight - terminalContent.clientHeight <= terminalContent.scrollTop + 50;
      
      // Sanitizar salida simple
      terminalContent.innerText = result.logs;
      
      // Auto-scroll si el usuario estaba al final
      if (isAtBottom) {
        terminalContent.scrollTop = terminalContent.scrollHeight;
      }
    }
  } catch (err) {
    terminalContent.innerText = `[DASHBOARD ERROR] No se pudieron recuperar los logs del servicio ${serviceName}: ${err.message}`;
  }
}

/* ==========================================================================
   MODAL MANAGER
   ========================================================================== */
function showModal() {
  confirmModal.classList.add('active');
}

function hideModal() {
  confirmModal.classList.remove('active');
  if (pendingAction === 'stop' && pendingService) {
    pendingAction = null;
    pendingService = null;
    fetchHealth();
  }
}
