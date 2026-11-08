const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Configuración y servicios modulares
const { PORT, BASE_PROYECTOS_DIR, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = require('./config/env');
const { scaffoldProject, deleteProjectFolder, SAFE_NAME_REGEX } = require('./services/scaffolderService');
const { createGitHubIssue, syncProjectWithGit } = require('./services/gitService');
const { ensureDominiosRunning, callDominiosAPI, createProjectCNAME, updateProjectCNAME, deleteProjectCNAME } = require('./services/dnsService');

const app = express();

// Almacenamiento en memoria para trabajos de creación asíncronos (jobs) con limpieza automática
const activeJobs = {};
const MAX_JOBS_HISTORY = 50;

function pruneOldJobs() {
  const keys = Object.keys(activeJobs);
  if (keys.length <= MAX_JOBS_HISTORY) return;
  const completedKeys = keys.filter(k => activeJobs[k].status !== 'running');
  while (Object.keys(activeJobs).length > MAX_JOBS_HISTORY && completedKeys.length > 0) {
    const oldest = completedKeys.shift();
    delete activeJobs[oldest];
  }
}

// Middlewares globales de seguridad y utilidades
app.use(helmet({
  contentSecurityPolicy: false // Desactivar CSP estricto para permitir el renderizado y carga de fuentes/CDNs de la SPA local
}));
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  // Normalizar rutas cuando entran por el API Gateway (/api/proj/projects -> /api/projects)
  if (req.url !== '/' && !req.url.startsWith('/ping') && !req.url.startsWith('/api/')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'infra-project-creator',
    port: PORT,
    status: 'online'
  });
});



/**
 * Helper para verificar la disponibilidad de comandos en el sistema sin disparar DEP0190
 */
function checkTool(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(`${cmd} ${args.join(' ')}`, { shell: true, windowsHide: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// 1. Health check de la API
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// 2. Diagnóstico de herramientas de entorno local
app.get('/api/diagnose', async (req, res) => {
  try {
    const nodeOk = await checkTool('node', ['-v']);
    const gitOk = await checkTool('git', ['--version']);
    const pythonOk = await checkTool('python', ['--version']);
    res.json({ node: nodeOk, git: gitOk, python: pythonOk });
  } catch (error) {
    res.status(500).json({ error: 'Fallo al ejecutar diagnóstico: ' + error.message });
  }
});

// 3. Obtener listado de proyectos centralizados y el dominio configurado
app.get('/api/projects', async (req, res) => {
  try {
    const projectsJsonPath = path.join(BASE_PROYECTOS_DIR, 'projects.json');
    let projects = [];
    if (fs.existsSync(projectsJsonPath)) {
      projects = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
    }
    
    let baseDomain = 'tus-proyectos.com';
    try {
      await ensureDominiosRunning();
      const configRes = await callDominiosAPI('/api/config', 'GET');
      if (configRes.success && configRes.baseDomain) {
        baseDomain = configRes.baseDomain;
      }
    } catch (e) {
      console.warn('No se pudo conectar con gestion-dominios para obtener baseDomain:', e.message);
    }
    
    res.json({ projects, baseDomain });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener proyectos: ' + err.message });
  }
});

// 4. Obtener estado e historial de logs de un Job específico
app.get('/api/status', (req, res) => {
  const { jobId } = req.query;
  if (!jobId || !activeJobs[jobId]) {
    return res.status(404).json({ error: 'Trabajo no encontrado' });
  }
  res.json({
    status: activeJobs[jobId].status,
    logs: activeJobs[jobId].logs
  });
});

// 5. Endpoint Principal: Crear Proyecto (Scaffolding Completo)
app.post('/api/projects/create', async (req, res) => {
  try {
    const { name, type, description, author, extras = ['gitignore', 'changelog'], customDependencies = [] } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Falta el nombre (name) o el tipo (type) del proyecto' });
    }

    const nameClean = name.trim().replace(/\s+/g, '-');
    const subfolder = nameClean.toLowerCase().startsWith('infra-') || ['crear-proyecto', 'project-creator', 'github', 'firbase', 'firebase', 'gateway', 'gestion-dominios', 'domain-manager'].includes(nameClean.toLowerCase()) ? 'infra' : 'apps';
    const projectPath = path.join(BASE_PROYECTOS_DIR, subfolder, nameClean);

    // Validar existencia previa para responder rápido antes de iniciar el Job
    if (fs.existsSync(projectPath)) {
      return res.status(400).json({ error: `La carpeta "${nameClean}" ya existe en el monorepositorio.` });
    }

    const jobId = Date.now().toString();
    pruneOldJobs();
    activeJobs[jobId] = {
      status: 'running',
      logs: [],
      config: { 
        name: nameClean, 
        type, 
        description, 
        author, 
        extras, 
        customDependencies,
        hostingType: req.body.hostingType || 'github',
        firebaseSiteId: req.body.firebaseSiteId || null
      }
    };

    // Responder inmediatamente con el ID de la tarea asíncrona
    res.json({ jobId, message: 'Proceso de creación de proyecto iniciado.' });

    // Ejecutar flujo de creación en segundo plano
    (async () => {
      const activeJobsRef = activeJobs; // Referencia
      const scaffoldSuccess = await scaffoldProject(jobId, activeJobsRef, activeJobsRef[jobId].config);
      
      const log = (msg) => {
        const timestamp = new Date().toLocaleTimeString();
        if (activeJobsRef[jobId]) activeJobsRef[jobId].logs.push(`[${timestamp}] ${msg}`);
      };

      if (!scaffoldSuccess) {
        activeJobsRef[jobId].status = 'failed';
        return;
      }

      // 5.1 Registrar proyecto en projects.json central
      const projectsJsonPath = path.join(BASE_PROYECTOS_DIR, 'projects.json');
      try {
        let projectsData = [];
        if (fs.existsSync(projectsJsonPath)) {
          projectsData = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
        }
        
        if (!projectsData.some(p => p.name === nameClean)) {
          projectsData.push({
            name: nameClean,
            type,
            description: description || '',
            author: author || 'JoelJuana',
            createdAt: new Date().toISOString().split('T')[0],
            hasPosts: true
          });
          fs.writeFileSync(projectsJsonPath, JSON.stringify(projectsData, null, 2), 'utf8');
          log('✓ Proyecto registrado en projects.json central.');
        }
      } catch (e) {
        log(`⚠️ Advertencia: No se pudo registrar en projects.json: ${e.message}`);
      }

      // 5.2 Registrar DNS CNAME en Cloudflare llamando a gestion-dominios
      const dnsOptions = {
        hostingType: activeJobsRef[jobId].config.hostingType,
        firebaseSiteId: activeJobsRef[jobId].config.firebaseSiteId
      };
      await createProjectCNAME(nameClean, activeJobsRef, jobId, dnsOptions);

      // 5.3 Crear Issue inicial de tareas en GitHub si hay credenciales
      if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
        log('Creando Issue inicial de bienvenida en GitHub...');
        const issueTitle = `Inicialización del proyecto: ${nameClean}`;
        const issueBody = `Se ha inicializado con éxito el subproyecto **${nameClean}** de tipo *${type}* en el monorepositorio.\n\n### Lista de Tareas Iniciales:\n- [ ] Completar documentación técnica en \`${nameClean}/posts/documentacion-inicial.md\`.\n- [ ] Configurar variables de entorno en \`${nameClean}/.env\` (si aplica).\n- [ ] Escribir los primeros tests unitarios.\n\n*Creado de forma automatizada por Project Creator.*`;
        
        const issueRes = await createGitHubIssue(issueTitle, issueBody, ['project-init', type]);
        if (issueRes.success) {
          log(`✓ Issue de GitHub creado con éxito: #${issueRes.number} (${issueRes.html_url})`);
        } else {
          log(`⚠️ Advertencia: No se pudo crear el Issue en GitHub: ${issueRes.error}`);
        }
      }

      // 5.4 Sincronizar el monorepositorio con Git
      await syncProjectWithGit(nameClean, activeJobsRef, jobId);

      activeJobsRef[jobId].status = 'completed';
      log(`✓ Proceso de creación y automatización de "${nameClean}" finalizado con éxito.`);
    })();

  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor: ' + err.message });
  }
});

// 5.5 Endpoint: Eliminar Proyecto de forma segura
app.delete('/api/projects/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const cleanName = name.trim().replace(/\s+/g, '-');
    
    // 1. Borrado físico del directorio
    deleteProjectFolder(cleanName);
    
    // 2. Modificar projects.json central
    let projectsJsonPath = path.join(BASE_PROYECTOS_DIR, 'projects.json');
    if (fs.existsSync(projectsJsonPath)) {
      try {
        const projectsData = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
        const filteredData = projectsData.filter(p => p.name !== cleanName);
        fs.writeFileSync(projectsJsonPath, JSON.stringify(filteredData, null, 2), 'utf8');
      } catch (e) {
        console.warn('No se pudo actualizar projects.json central al eliminar:', e.message);
      }
    }
    
    // 3. Dar de baja DNS en Cloudflare
    let dnsMsg = 'Omitido';
    try {
      dnsMsg = await deleteProjectCNAME(cleanName);
    } catch (e) {
      console.warn('Error al dar de baja DNS CNAME:', e.message);
    }
    
    // 4. Sincronizar en Git a nivel de monorepositorio
    let gitMsg = 'Repositorio Git maestro no detectado.';
    const masterGitDir = path.join(BASE_PROYECTOS_DIR, '.git');
    if (fs.existsSync(masterGitDir)) {
      try {
        const runGit = (args) => {
          return new Promise((resolve) => {
            const p = spawn('git', args, { cwd: BASE_PROYECTOS_DIR, shell: false, windowsHide: true });
            p.on('close', (code) => resolve(code === 0));
            p.on('error', () => resolve(false));
          });
        };
        
        const subfolder = cleanName.toLowerCase().startsWith('infra-') || ['crear-proyecto', 'project-creator', 'github', 'firbase', 'firebase', 'gateway', 'gestion-dominios', 'domain-manager'].includes(cleanName.toLowerCase()) ? 'infra' : 'apps';
        await runGit(['rm', '-r', '--cached', `${subfolder}/${cleanName}`]);
        await runGit(['add', 'projects.json']);
        
        const commitMsg = `chore(${cleanName}): eliminar proyecto y dar de baja DNS de forma automatizada`;
        await runGit(['commit', '-m', commitMsg]);
        await runGit(['push', 'origin', 'main']);
        gitMsg = 'Confirmado y sincronizado en GitHub.';
      } catch (e) {
        gitMsg = `Error al sincronizar con Git: ${e.message}`;
      }
    }
    
    res.json({
      success: true,
      message: `Proyecto '${cleanName}' eliminado con éxito.`,
      details: {
        dirDeleted: true,
        dnsStatus: dnsMsg,
        gitStatus: gitMsg
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al eliminar proyecto: ' + err.message });
  }
});

// 6. Endpoint: Renombrar Proyecto y actualizar subdominio
app.post('/api/projects/rename', async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    
    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Faltan oldName o newName en la solicitud' });
    }
    const cleanOld = oldName.trim().replace(/\s+/g, '-');
    const cleanNew = newName.trim().replace(/\s+/g, '-');

    if (!SAFE_NAME_REGEX.test(cleanOld) || !SAFE_NAME_REGEX.test(cleanNew)) {
      return res.status(400).json({ error: 'El nombre del proyecto contiene caracteres no permitidos.' });
    }
    
    const oldSubfolder = cleanOld.toLowerCase().startsWith('infra-') || ['crear-proyecto', 'project-creator', 'github', 'firbase', 'firebase', 'gateway', 'gestion-dominios', 'domain-manager'].includes(cleanOld.toLowerCase()) ? 'infra' : 'apps';
    const newSubfolder = cleanNew.toLowerCase().startsWith('infra-') || ['crear-proyecto', 'project-creator', 'github', 'firbase', 'firebase', 'gateway', 'gestion-dominios', 'domain-manager'].includes(cleanNew.toLowerCase()) ? 'infra' : 'apps';
    
    const oldPath = path.join(BASE_PROYECTOS_DIR, oldSubfolder, cleanOld);
    const newPath = path.join(BASE_PROYECTOS_DIR, newSubfolder, cleanNew);
    
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: `El proyecto '${cleanOld}' no existe físicamente.` });
    }
    
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: `Ya existe una carpeta con el nombre '${cleanNew}' en la raíz.` });
    }
    
    // 1. Renombrar carpeta física
    fs.renameSync(oldPath, newPath);
    
    // 2. Modificar package.json en la nueva carpeta
    const pkgPath = path.join(newPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.name = cleanNew.toLowerCase();
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
      } catch (e) {
        console.warn('No se pudo actualizar package.json del proyecto renombrado:', e.message);
      }
    }
    
    // 3. Modificar projects.json central
    const projectsJsonPath = path.join(BASE_PROYECTOS_DIR, 'projects.json');
    if (fs.existsSync(projectsJsonPath)) {
      try {
        const projectsData = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
        const projIndex = projectsData.findIndex(p => p.name === cleanOld);
        if (projIndex !== -1) {
          projectsData[projIndex].name = cleanNew;
          fs.writeFileSync(projectsJsonPath, JSON.stringify(projectsData, null, 2), 'utf8');
        }
      } catch (e) {
        console.warn('No se pudo actualizar projects.json central:', e.message);
      }
    }
    
    // 4. Actualizar subdominio Cloudflare
    let dnsDetails = { deleted: 'Omitido', created: 'Omitido' };
    try {
      dnsDetails = await updateProjectCNAME(cleanOld, cleanNew);
    } catch (e) {
      console.warn('Error al actualizar DNS CNAME:', e.message);
    }
    
    // 5. Sincronizar en Git y empujar commits
    let gitMsg = 'Repositorio Git maestro no detectado.';
    const masterGitDir = path.join(BASE_PROYECTOS_DIR, '.git');
    if (fs.existsSync(masterGitDir)) {
      try {
        const runGit = (args) => {
          return new Promise((resolve) => {
            const p = spawn('git', args, { cwd: BASE_PROYECTOS_DIR, shell: false, windowsHide: true });
            p.on('close', (code) => resolve(code === 0));
            p.on('error', () => resolve(false));
          });
        };
        
        await runGit(['rm', '-r', '--cached', `${oldSubfolder}/${cleanOld}`]);
        await runGit(['add', `${newSubfolder}/${cleanNew}`]);
        await runGit(['add', 'projects.json']);
        
        const commitMsg = `refactor(${cleanNew}): renombrar proyecto desde ${cleanOld} y actualizar DNS`;
        await runGit(['commit', '-m', commitMsg]);
        await runGit(['push', 'origin', 'main']);
        gitMsg = 'Confirmado y subido a GitHub con éxito.';
      } catch (e) {
        gitMsg = `Error al sincronizar con Git: ${e.message}`;
      }
    }
    
    res.json({
      success: true,
      message: `Proyecto renombrado con éxito a '${cleanNew}'.`,
      details: {
        dirRenamed: true,
        dnsDeleted: dnsDetails.deleted,
        dnsCreated: dnsDetails.created,
        gitStatus: gitMsg
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo interno al renombrar: ' + err.message });
  }
});

// 7. Endpoint: Apagar servidor de scaffolding
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Servidor Express apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Manejador de errores global para Express
app.use((err, req, res, next) => {
  console.error('[Error de Servidor]', err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`⚡ Servidor Express de Project Creator activo en http://localhost:${PORT}`);
  });
}

module.exports = app;
