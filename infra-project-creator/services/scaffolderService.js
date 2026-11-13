const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BASE_PROYECTOS_DIR } = require('../config/env');

// Expresión regular para validar nombres de carpeta seguros y limpios
const SAFE_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;

// Extensiones de archivo de texto que deben procesar placeholders
const TEXT_EXTENSIONS = new Set([
  '.json', '.js', '.jsx', '.html', '.css', '.py', '.md', '.txt',
  '.config', '.env', '.example', '.yml', '.yaml', '.gitignore'
]);

/**
 * Reemplaza los placeholders de plantilla en un texto
 */
function replacePlaceholders(content, data) {
  let result = content;
  result = result.replace(/{{PROJECT_NAME}}/g, data.name || '');
  result = result.replace(/{{nameClean}}/g, data.nameClean || '');
  result = result.replace(/{{PROJECT_DESCRIPTION}}/g, data.description || '');
  result = result.replace(/{{AUTHOR}}/g, data.author || 'JoelJuana');
  result = result.replace(/{{CREATED_DATE}}/g, data.date || new Date().toISOString().split('T')[0]);
  result = result.replace(/{{CDN_SCRIPTS}}/g, data.cdnScripts || '');
  return result;
}

/**
 * Copia un archivo aplicando reemplazos de plantilla si es de texto
 */
function copyFileWithTemplate(src, dest, data) {
  const ext = path.extname(src).toLowerCase();
  
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(path.basename(src))) {
    const content = fs.readFileSync(src, 'utf8');
    const processed = replacePlaceholders(content, data);
    fs.writeFileSync(dest, processed, 'utf8');
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Copia un directorio recursivamente
 */
function copyRecursiveSync(src, dest, data) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  
  if (isDirectory) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName),
        data
      );
    });
  } else {
    copyFileWithTemplate(src, dest, data);
  }
}

/**
 * Ejecuta un comando en un directorio específico de forma asíncrona y guarda logs
 */
function runCommand(jobId, activeJobs, command, args, cwd) {
  return new Promise((resolve) => {
    const timestamp = () => new Date().toLocaleTimeString();
    const log = (msg) => {
      if (activeJobs[jobId]) {
        activeJobs[jobId].logs.push(`[${timestamp()}] ${msg}`);
      }
    };

    log(`> Ejecutando: ${command} ${args.join(' ')}`);
    const process = spawn(command, args, { cwd, shell: true });

    process.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) log(text);
    });

    process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text && !text.includes('npm WARN')) {
        log(`[WARN/STDERR] ${text}`);
      }
    });

    process.on('close', (code) => {
      if (code === 0) {
        log(`✓ Comando completado con éxito.`);
        resolve(true);
      } else {
        log(`❌ Comando finalizado con código de salida ${code}.`);
        resolve(false);
      }
    });

    process.on('error', (err) => {
      log(`❌ Error de sistema al ejecutar comando: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * Helper para determinar en qué subcarpeta se debe colocar el proyecto.
 * Desde la reestructuración, todos los proyectos de negocio van a 'apps/'.
 * Los proyectos de infraestructura se gestionan directamente en IA_Infraestructura.
 */
function getProjectSubfolder(name, type) {
  const clean = name.toLowerCase();
  const infraNames = ['crear-proyecto', 'project-creator', 'github', 'firbase', 'firebase', 'gateway', 'gestion-dominios', 'domain-manager'];
  if (clean.startsWith('infra-') || infraNames.includes(clean)) {
    console.warn(`⚠️ "${name}" parece un proyecto de infraestructura. Los proyectos de infra se gestionan en C:\\Users\\jjtei\\Desktop\\IA_Infraestructura, no en el monorepositorio de apps.`);
    return 'infra';
  }
  if (clean.startsWith('app-bp-')) {
    return path.join('apps', 'business-plans');
  }
  return 'apps';
}

/**
 * Crea e inicializa la estructura física del proyecto
 */
async function scaffoldProject(jobId, activeJobs, config) {
  const { name, type, description, author, extras = [], customDependencies = [] } = config;
  const nameClean = name.trim().replace(/\s+/g, '-');
  const subfolder = getProjectSubfolder(nameClean, type);
  const projectPath = path.join(BASE_PROYECTOS_DIR, subfolder, nameClean);
  const templatesRoot = path.join(BASE_PROYECTOS_DIR, '_plantillas');
  const templatePath = path.join(templatesRoot, type);

  const timestamp = () => new Date().toLocaleTimeString();
  const log = (msg) => {
    if (activeJobs[jobId]) {
      activeJobs[jobId].logs.push(`[${timestamp()}] ${msg}`);
    }
  };

  try {
    log(`Iniciando creación del proyecto: "${nameClean}" (${type})`);

    // 1. Validaciones
    if (!SAFE_NAME_REGEX.test(nameClean)) {
      log(`❌ Error: El nombre del proyecto contiene caracteres no permitidos.`);
      activeJobs[jobId].status = 'failed';
      return false;
    }

    if (fs.existsSync(projectPath)) {
      log(`❌ Error: La carpeta "${nameClean}" ya existe en ${BASE_PROYECTOS_DIR}`);
      activeJobs[jobId].status = 'failed';
      return false;
    }

    if (!fs.existsSync(templatePath)) {
      log(`❌ Error: La plantilla para el tipo "${type}" no existe en _plantillas/`);
      activeJobs[jobId].status = 'failed';
      return false;
    }

    // 2. Copiar estructura inicial
    log(`Copiando plantilla desde _plantillas/${type} ...`);
    const templateData = {
      name: nameClean,
      nameClean: nameClean.toLowerCase(),
      description: description || 'Proyecto creado de forma automatizada.',
      author: author || 'JoelJuana',
      date: new Date().toISOString().split('T')[0],
      cdnScripts: extras.includes('chartjs') && type === 'vanilla'
        ? '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>'
        : ''
    };

    copyRecursiveSync(templatePath, projectPath, templateData);
    log(`Estructura base copiada con éxito.`);

    // 3. Crear extras universales (si no están incluidos en la plantilla)
    if (extras.includes('gitignore') && !fs.existsSync(path.join(projectPath, '.gitignore'))) {
      const gitignoreContent = 'node_modules/\n.env\nvenv/\n.DS_Store\n*.log\ndist/\nbuild/\ncoverage/\n.parcel-cache/\n';
      fs.writeFileSync(path.join(projectPath, '.gitignore'), gitignoreContent, 'utf8');
      log(`✓ Archivo .gitignore de respaldo creado.`);
    }

    if (extras.includes('changelog') && !fs.existsSync(path.join(projectPath, 'CHANGELOG.md'))) {
      const changelogContent = `# Historial de Cambios - ${nameClean}\n\n## [1.0.0] - ${templateData.date}\n- Inicialización de estructura mediante la API de Scaffolding.\n`;
      fs.writeFileSync(path.join(projectPath, 'CHANGELOG.md'), changelogContent, 'utf8');
      log(`✓ Archivo CHANGELOG.md creado.`);
    }

    if (extras.includes('license') && !fs.existsSync(path.join(projectPath, 'LICENSE'))) {
      const licenseContent = `MIT License\n\nCopyright (c) ${new Date().getFullYear()} ${templateData.author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...`;
      fs.writeFileSync(path.join(projectPath, 'LICENSE'), licenseContent, 'utf8');
      log(`✓ Archivo LICENSE creado.`);
    }

    // Crear carpeta posts y documentación de forma estándar
    const postsDir = path.join(projectPath, 'posts');
    if (!fs.existsSync(postsDir)) {
      fs.mkdirSync(postsDir, { recursive: true });
      const docContent = `---\ntitle: 'Documentación Inicial de ${nameClean}'\ndate: '${templateData.date}'\nstatus: 'published'\n---\n\n# Documentación de ${nameClean}\n\nEste proyecto ha sido creado usando la API de Scaffolding e integrado bajo el monorepositorio **Proyectos IA**.\n`;
      fs.writeFileSync(path.join(postsDir, 'documentacion-inicial.md'), docContent, 'utf8');
      log(`✓ Estructura de documentación y posts inicializada.`);
    }

    // 4. Instalar dependencias locales de forma asíncrona (se omiten en modo de pruebas)
    if (process.env.NODE_ENV === 'test') {
      log('[Test Mode] Omitiendo la instalación de dependencias en el sandbox de pruebas.');
    } else if (type === 'python') {
      log(`Creando entorno virtual (venv)...`);
      const successVenv = await runCommand(jobId, activeJobs, 'python', ['-m', 'venv', 'venv'], projectPath);
      if (successVenv) {
        log(`Instalando dependencias Pip iniciales...`);
        const pipCmd = path.join(projectPath, 'venv', 'Scripts', 'pip.exe');
        
        const pipArgs = ['install', '-r', 'requirements.txt'];
        if (customDependencies.length > 0) {
          pipArgs.push(...customDependencies);
        }
        await runCommand(jobId, activeJobs, pipCmd, pipArgs, projectPath);
      } else {
        log(`⚠️ Advertencia: No se pudo crear el entorno virtual de Python.`);
      }
    } else {
      // Proyectos de Node/Vite/React/API
      if (customDependencies.length > 0) {
        log(`Agregando dependencias personalizadas al package.json...`);
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (!pkg.dependencies) pkg.dependencies = {};
            customDependencies.forEach(dep => {
              pkg.dependencies[dep] = 'latest';
            });
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
          } catch (e) {
            log(`⚠️ Error al actualizar package.json con dependencias personalizadas: ${e.message}`);
          }
        }
      }

      log(`Instalando dependencias npm en el nuevo proyecto...`);
      await runCommand(jobId, activeJobs, 'npm', ['install'], projectPath);
    }

    return true;
  } catch (err) {
    log(`❌ Error crítico en el Scaffolder: ${err.message}`);
    activeJobs[jobId].status = 'failed';
    return false;
  }
}

const CRITICAL_FOLDERS = new Set([
  'infra-project-creator', 'infra-github', 'infra-domain-manager', 'infra-firebase', 'infra-gateway',
  'api-design-assets', 'api-conocimiento-rag', 'api-utilidades-scraping',
  'crear-proyecto', 'gestion-dominios', 'github', 'firebase', 'gateway',
  'apps', 'infra', '_plantillas', '_documentos', 'scripts', '.git', '.github', '.husky', 'node_modules', 'dist'
]);

/**
 * Elimina físicamente y de forma segura una carpeta de proyecto
 */
function deleteProjectFolder(projectName) {
  const nameClean = projectName.trim().replace(/\s+/g, '-');
  
  // 1. Validar nombre seguro
  if (!SAFE_NAME_REGEX.test(nameClean)) {
    throw new Error('El nombre del proyecto contiene caracteres no permitidos.');
  }
  
  // 2. Proteger directorios críticos
  if (CRITICAL_FOLDERS.has(nameClean.toLowerCase()) || nameClean === '.' || nameClean === '..') {
    throw new Error(`Operación denegada: '${nameClean}' es un componente de infraestructura protegido.`);
  }
  
  // Buscar en apps, apps/business-plans e infra
  let projectPath = path.join(BASE_PROYECTOS_DIR, 'apps', nameClean);
  if (!fs.existsSync(projectPath)) {
    projectPath = path.join(BASE_PROYECTOS_DIR, 'apps', 'business-plans', nameClean);
  }
  if (!fs.existsSync(projectPath)) {
    projectPath = path.join(BASE_PROYECTOS_DIR, 'infra', nameClean);
  }
  
  // 3. Validar existencia
  if (!fs.existsSync(projectPath)) {
    throw new Error(`El proyecto '${nameClean}' no existe físicamente en el disco.`);
  }
  
  // 4. Borrado físico recursivo
  fs.rmSync(projectPath, { recursive: true, force: true });
  return true;
}

module.exports = {
  scaffoldProject,
  deleteProjectFolder,
  getProjectSubfolder,
  SAFE_NAME_REGEX
};
