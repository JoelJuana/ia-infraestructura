const { spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { BASE_PROYECTOS_DIR, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = require('../config/env');

/**
 * Crea un Issue en GitHub de forma automatizada
 */
function createGitHubIssue(title, body, labels = []) {
  return new Promise((resolve) => {
    if (process.env.NODE_ENV === 'test') {
      return resolve({ success: true, number: 1, html_url: 'https://github.com/mock/issue/1' });
    }
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
      resolve({
        success: false,
        error: 'Faltan credenciales de GitHub (Token, Owner o Repo) en el entorno.'
      });
      return;
    }

    const postData = JSON.stringify({
      title,
      body,
      labels
    });

    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
      method: 'POST',
      headers: {
        'User-Agent': 'Proyectos-IA-Crear-Proyecto-Service',
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          try {
            const issue = JSON.parse(data);
            resolve({
              success: true,
              number: issue.number,
              html_url: issue.html_url
            });
          } catch (e) {
            resolve({ success: false, error: 'Error al parsear respuesta de GitHub.' });
          }
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Ejecuta un comando git y lo loguea
 */
function runGitCommand(command, args, cwd, logFn) {
  return new Promise((resolve) => {
    logFn(`> Ejecutando git: git ${args.join(' ')}`);
    const process = spawn(command, args, { cwd, shell: false, windowsHide: true });

    process.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) logFn(text);
    });

    process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) logFn(`[Git info] ${text}`);
    });

    process.on('close', (code) => {
      resolve(code === 0);
    });

    process.on('error', (err) => {
      logFn(`❌ Error en Git: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * Realiza la sincronización automática de Git del monorepositorio
 */
async function syncProjectWithGit(projectName, activeJobs, jobId) {
  const timestamp = () => new Date().toLocaleTimeString();
  const log = (msg) => {
    if (activeJobs[jobId]) {
      activeJobs[jobId].logs.push(`[${timestamp()}] ${msg}`);
    }
  };

  if (process.env.NODE_ENV === 'test') {
    log(`[Test Mode] Omitiendo comandos Git reales para '${projectName}'.`);
    return true;
  }

  const gitDir = path.join(BASE_PROYECTOS_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    log(`⚠️ Repositorio Git maestro no detectado en la raíz. Omitiendo sincronización Git.`);
    return false;
  }

  log(`Sincronizando nuevo proyecto '${projectName}' con Git/GitHub...`);

  // 1. git add (soportando tanto apps/<projectName> como raíz)
  const appRelPath = fs.existsSync(path.join(BASE_PROYECTOS_DIR, 'apps', projectName))
    ? `apps/${projectName}`
    : projectName;
  await runGitCommand('git', ['add', appRelPath], BASE_PROYECTOS_DIR, log);
  
  if (fs.existsSync(path.join(BASE_PROYECTOS_DIR, 'package-lock.json'))) {
    await runGitCommand('git', ['add', 'package-lock.json'], BASE_PROYECTOS_DIR, log);
  }
  
  await runGitCommand('git', ['add', 'projects.json'], BASE_PROYECTOS_DIR, log);

  // 2. git commit
  const commitMsg = `feat(${projectName}): inicializar estructura de proyecto mediante la API de Scaffolding`;
  await runGitCommand('git', ['commit', '-m', commitMsg], BASE_PROYECTOS_DIR, log);

  // 3. git push
  log(`Subiendo cambios al repositorio de GitHub...`);
  const successPush = await runGitCommand('git', ['push', 'origin', 'main'], BASE_PROYECTOS_DIR, log);
  if (successPush) {
    log(`✓ Sincronización con GitHub completada exitosamente.`);
    return true;
  } else {
    log(`⚠️ Advertencia: No se pudo subir los cambios a GitHub de forma automática.`);
    return false;
  }
}

module.exports = {
  createGitHubIssue,
  syncProjectWithGit
};
