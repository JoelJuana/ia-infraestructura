const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Octokit } = require('@octokit/rest');

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || process.env.GITHUB_SERVICE_PORT || 3100;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  // Normalizar rutas cuando entran por el API Gateway (/api/git/config -> /api/config)
  if (req.url !== '/' && !req.url.startsWith('/ping') && !req.url.startsWith('/local/') && !req.url.startsWith('/api/')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'infra-github',
    port: PORT,
    status: 'online'
  });
});

let octokitInstance = null;

function getOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN no configurado. Por favor, configúralo en tu archivo .env o en el monorepositorio.'
    );
  }
  if (!octokitInstance) {
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

// Resetear la instancia de Octokit cuando cambie el token
function resetOctokit() {
  octokitInstance = null;
}

// Helper para guardar variables en el archivo .env
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

  // Re-escribir archivo
  const newContent = Object.entries(updatedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  fs.writeFileSync(envPath, newContent, 'utf8');

  // Actualizar process.env en tiempo de ejecución
  Object.entries(vars).forEach(([k, v]) => {
    process.env[k] = v;
  });

  resetOctokit();
}

// --- Endpoints de Configuración ---

// Obtener configuración actual (sin revelar completamente el token)
app.get('/api/config', (req, res) => {
  const token = process.env.GITHUB_TOKEN || '';
  const maskedToken = token
    ? `${token.substring(0, 4)}...${token.substring(token.length - 4)}`
    : '';

  res.json({
    hasToken: !!token,
    maskedToken: maskedToken,
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    branch: process.env.GITHUB_BRANCH || 'main',
    postsPath: process.env.GITHUB_POSTS_PATH || 'posts'
  });
});

// Guardar nueva configuración
app.post('/api/config', (req, res) => {
  const { token, owner, repo, branch, postsPath } = req.body;

  try {
    const varsToUpdate = {
      GITHUB_OWNER: owner || '',
      GITHUB_REPO: repo || '',
      GITHUB_BRANCH: branch || 'main',
      GITHUB_POSTS_PATH: postsPath || 'posts'
    };

    // Si se pasa un nuevo token, se actualiza. Si no, se mantiene el anterior.
    if (token && !token.includes('...')) {
      varsToUpdate.GITHUB_TOKEN = token;
    }

    writeEnvFile(varsToUpdate);
    res.json({ success: true, message: 'Configuración guardada con éxito.' });
  } catch (err) {
    res
      .status(500)
      .json({ error: 'Error al escribir el archivo de configuración: ' + err.message });
  }
});

// Listar subproyectos en el monorepositorio local
app.get('/api/projects', (req, res) => {
  try {
    const rootPath = path.join(__dirname, '..');
    const projectsJsonPath = path.join(rootPath, 'projects.json');

    if (fs.existsSync(projectsJsonPath)) {
      const data = fs.readFileSync(projectsJsonPath, 'utf8');
      return res.json(JSON.parse(data));
    }

    // Fallback: si no existe el JSON central, listar carpetas
    const items = fs.readdirSync(rootPath);
    const fallbackProjects = items
      .filter(item => {
        const fullPath = path.join(rootPath, item);
        return (
          fs.statSync(fullPath).isDirectory() &&
          !item.startsWith('.') &&
          item !== 'node_modules' &&
          item !== 'scripts'
        );
      })
      .map(name => ({
        name,
        type: 'vanilla',
        description: 'Proyecto local de Proyectos IA.',
        author: 'JoelJuana',
        createdAt: new Date().toISOString().split('T')[0],
        hasPosts: true
      }));

    res.json(fallbackProjects);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar proyectos: ' + err.message });
  }
});

// --- Función de Validación de Frontmatter en el Backend ---
function validatePostContent(filename, content) {
  if (!filename.endsWith('.md') && !filename.endsWith('.markdown')) {
    throw new Error('El nombre de archivo debe tener la extensión .md o .markdown');
  }

  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  if (!match) {
    throw new Error('El post debe incluir un encabezado Frontmatter válido delimitado por "---".');
  }

  const yamlBlock = match[1];
  const metadata = {};
  yamlBlock.split('\n').forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      metadata[key] = parts.slice(1).join(':').trim();
    }
  });

  if (!metadata.title || metadata.title.replace(/['"]/g, '').trim() === '') {
    throw new Error('El campo "title" en los metadatos es obligatorio.');
  }

  if (metadata.date) {
    const dateVal = metadata.date.replace(/['"]/g, '').trim();
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateVal) && dateVal !== '') {
      throw new Error('El campo "date" debe tener el formato AAAA-MM-DD.');
    }
  }
}

// --- Endpoints de Gestión de Ramas (Branches) ---

// Listar ramas
app.get('/api/branches', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    const response = await octokit.repos.listBranches({ owner, repo });
    const branches = response.data.map(b => ({ name: b.name }));
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar ramas: ' + err.message });
  }
});

// Crear una nueva rama
app.post('/api/branches', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { branchName, fromBranch } = req.body;

    if (!branchName) {
      return res.status(400).json({ error: 'El nombre de la rama es obligatorio.' });
    }

    const baseBranch = fromBranch || process.env.GITHUB_BRANCH || 'main';

    // 1. Obtener SHA del commit de la rama base
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });
    const sha = baseRef.data.object.sha;

    // 2. Crear la nueva rama
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha
    });

    res.json({
      success: true,
      message: `Rama "${branchName}" creada a partir de "${baseBranch}".`,
      sha
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear la rama: ' + err.message });
  }
});

// --- Endpoints de Gestión de Pull Requests (PRs) ---

// Listar Pull Requests abiertos
app.get('/api/pulls', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    const response = await octokit.pulls.list({
      owner,
      repo,
      state: 'open'
    });

    const pulls = await Promise.all(
      response.data.map(async pr => {
        let checkState = 'unknown';
        try {
          // Consultar el estado combinado de los checks para el último commit del PR
          const checksRes = await octokit.checks.listForRef({
            owner,
            repo,
            ref: pr.head.sha
          });

          if (checksRes.data.total_count > 0) {
            const checkRuns = checksRes.data.check_runs;
            const failures = checkRuns.filter(
              run => run.conclusion === 'failure' || run.conclusion === 'action_required'
            );
            const running = checkRuns.filter(run => run.status !== 'completed');

            if (failures.length > 0) {
              checkState = 'failure';
            } else if (running.length > 0) {
              checkState = 'pending';
            } else {
              const successes = checkRuns.filter(
                run => run.conclusion === 'success' || run.conclusion === 'neutral'
              );
              if (successes.length > 0) {
                checkState = 'success';
              }
            }
          }
        } catch (checkErr) {
          console.error(`Error al obtener checks para PR #${pr.number}:`, checkErr.message);
        }

        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          html_url: pr.html_url,
          headBranch: pr.head.ref,
          baseBranch: pr.base.ref,
          user: pr.user.login,
          checkState
        };
      })
    );

    res.json(pulls);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar Pull Requests: ' + err.message });
  }
});

// Crear un Pull Request
app.post('/api/pulls', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { title, headBranch, baseBranch, body } = req.body;

    if (!title || !headBranch) {
      return res
        .status(400)
        .json({ error: 'El título y la rama de origen (headBranch) son obligatorios.' });
    }

    const base = baseBranch || process.env.GITHUB_BRANCH || 'main';

    const response = await octokit.pulls.create({
      owner,
      repo,
      title,
      head: headBranch,
      base,
      body: body || 'Creado automáticamente desde GitPublish CMS.'
    });

    res.json({
      success: true,
      message: `Pull Request #${response.data.number} creado con éxito.`,
      number: response.data.number,
      html_url: response.data.html_url
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear Pull Request: ' + err.message });
  }
});

// Fusionar (Merge) un Pull Request
app.post('/api/pulls/:number/merge', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { number } = req.params;
    const { commitTitle } = req.body;

    const response = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: parseInt(number),
      commit_title: commitTitle || `Merge Pull Request #${number} from GitPublish CMS`
    });

    res.json({
      success: true,
      message: 'Pull Request fusionado con éxito.',
      merged: response.data.merged,
      sha: response.data.sha
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al fusionar Pull Request: ' + err.message });
  }
});

// Listar incidencias (Issues) de GitHub
app.get('/api/issues', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!owner || !repo) {
      return res
        .status(400)
        .json({ error: 'Configuración incompleta de GitHub (owner/repo vacíos).' });
    }

    const response = await octokit.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      sort: 'created',
      direction: 'desc'
    });

    // Mapear los datos de las incidencias (excluyendo Pull Requests que a veces la API de GitHub devuelve en el mismo endpoint)
    const issues = response.data
      .filter(issue => !issue.pull_request)
      .map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        html_url: issue.html_url,
        user: issue.user.login,
        created_at: issue.created_at,
        labels: issue.labels.map(l => l.name)
      }));

    res.json(issues);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar incidencias de GitHub: ' + err.message });
  }
});

// Crear una incidencia (Issue) en GitHub
app.post('/api/issues', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { title, body, labels } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'El título de la tarea es obligatorio.' });
    }

    const response = await octokit.issues.create({
      owner,
      repo,
      title,
      body: body || '',
      labels: labels || []
    });

    res.json({
      success: true,
      message: 'Tarea creada correctamente en GitHub.',
      issue: {
        number: response.data.number,
        title: response.data.title,
        html_url: response.data.html_url
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear la tarea en GitHub: ' + err.message });
  }
});

// --- Endpoints de la API de GitHub ---

// Listar publicaciones del repositorio
app.get('/api/posts', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    const { project } = req.query;
    let postsPath = process.env.GITHUB_POSTS_PATH || 'posts';
    if (project) {
      postsPath = `${project}/posts`;
    }

    if (!owner || !repo) {
      return res
        .status(400)
        .json({ error: 'Configuración de repositorio incompleta (owner o repo vacíos).' });
    }

    try {
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: postsPath,
        ref: branch
      });

      // Asegurarnos de que sea una lista de archivos
      if (Array.isArray(response.data)) {
        // Filtrar archivos markdown/txt
        const files = response.data
          .filter(
            item =>
              item.type === 'file' && (item.name.endsWith('.md') || item.name.endsWith('.markdown'))
          )
          .map(item => ({
            name: item.name,
            path: item.path,
            sha: item.sha,
            size: item.size,
            html_url: item.html_url
          }));

        return res.json(files);
      } else {
        return res.json([]);
      }
    } catch (apiErr) {
      // Si la carpeta no existe, devolvemos un array vacío en lugar de un error 404
      if (apiErr.status === 404) {
        return res.json([]);
      }
      throw apiErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener contenido de una publicación específica
app.get('/api/posts/:filename', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    const { filename } = req.params;
    const { project } = req.query;

    let postsPath = process.env.GITHUB_POSTS_PATH || 'posts';
    if (project) {
      postsPath = `${project}/posts`;
    }

    const fileResponse = await octokit.repos.getContent({
      owner,
      repo,
      path: path.join(postsPath, filename).replace(/\\/g, '/'),
      ref: branch
    });

    const content = Buffer.from(fileResponse.data.content, 'base64').toString('utf8');

    res.json({
      name: fileResponse.data.name,
      sha: fileResponse.data.sha,
      content: content
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el post: ' + err.message });
  }
});

// Guardar o actualizar un post
app.post('/api/posts', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    const { filename, content, sha, commitMessage, branch, project } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ error: 'Nombre de archivo y contenido son obligatorios.' });
    }

    // Validar el contenido (Frontmatter) antes de guardar en GitHub
    try {
      validatePostContent(filename, content);
    } catch (valErr) {
      return res.status(400).json({ error: 'Error de validación: ' + valErr.message });
    }

    let postsPath = process.env.GITHUB_POSTS_PATH || 'posts';
    if (project) {
      postsPath = `${project}/posts`;
    }

    const targetBranch = branch || process.env.GITHUB_BRANCH || 'main';
    const filePath = path.join(postsPath, filename).replace(/\\/g, '/');
    const contentBuffer = Buffer.from(content, 'utf8').toString('base64');

    const params = {
      owner,
      repo,
      path: filePath,
      message: commitMessage || `Update post: ${filename}`,
      content: contentBuffer,
      branch: targetBranch
    };

    // Si ya existe el archivo en GitHub (tenemos sha), debemos pasarlo para evitar conflictos
    if (sha) {
      params.sha = sha;
    }

    const response = await octokit.repos.createOrUpdateFileContents(params);

    res.json({
      success: true,
      message: 'Post guardado correctamente en GitHub.',
      commit: response.data.commit.sha,
      content: {
        name: response.data.content.name,
        sha: response.data.content.sha
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar el post: ' + err.message });
  }
});

// Eliminar un post
app.delete('/api/posts/:filename', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    const { filename } = req.params;
    const { sha, commitMessage, project } = req.body;

    if (!sha) {
      return res.status(400).json({ error: 'Se requiere el SHA del archivo para eliminarlo.' });
    }

    let postsPath = process.env.GITHUB_POSTS_PATH || 'posts';
    if (project) {
      postsPath = `${project}/posts`;
    }

    const filePath = path.join(postsPath, filename).replace(/\\/g, '/');

    const response = await octokit.repos.deleteFile({
      owner,
      repo,
      path: filePath,
      message: commitMessage || `Delete post: ${filename}`,
      sha,
      branch
    });

    res.json({
      success: true,
      message: 'Post eliminado correctamente de GitHub.',
      commit: response.data.commit.sha
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar el post: ' + err.message });
  }
});

// Subir un recurso (imagen / multimedia)
app.post('/api/media', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    // Recibe el base64 sin la cabecera (e.g. data:image/png;base64,...)
    const { filename, contentBase64, mediaFolder, commitMessage } = req.body;

    if (!filename || !contentBase64) {
      return res
        .status(400)
        .json({ error: 'Nombre del recurso e imagen en base64 son requeridos.' });
    }

    const folder = mediaFolder || 'assets/images';
    const filePath = path.join(folder, filename).replace(/\\/g, '/');

    const response = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: commitMessage || `Upload media: ${filename}`,
      content: contentBase64,
      branch
    });

    // Construir la URL raw de acceso a la imagen
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

    res.json({
      success: true,
      message: 'Archivo multimedia subido con éxito.',
      url: rawUrl,
      commit: response.data.commit.sha
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al subir recurso: ' + err.message });
  }
});

// --- Nuevos Endpoints para la Automatización vía Skill ---

// Health check rápido para el Skill
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// Listar repositorios del usuario autenticado
app.get('/api/repos', async (req, res) => {
  try {
    const octokit = getOctokit();
    const response = await octokit.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 100
    });
    const repos = response.data.map(r => ({
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      htmlUrl: r.html_url
    }));
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar repositorios: ' + err.message });
  }
});

// Crear un nuevo repositorio remoto
app.post('/api/repos', async (req, res) => {
  try {
    const octokit = getOctokit();
    const { name, description, private: isPrivate } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'El nombre del repositorio es obligatorio.' });
    }
    const response = await octokit.repos.createForAuthenticatedUser({
      name,
      description: description || 'Repositorio creado automáticamente por gestiona_github',
      private: isPrivate !== false,
      auto_init: false
    });
    res.json({
      success: true,
      message: `Repositorio "${name}" creado con éxito.`,
      repo: {
        name: response.data.name,
        fullName: response.data.full_name,
        htmlUrl: response.data.html_url
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear el repositorio: ' + err.message });
  }
});

// Obtener los últimos commits de una rama
app.get('/api/commits', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = req.query.branch || process.env.GITHUB_BRANCH || 'main';
    const limit = parseInt(req.query.limit) || 10;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    const response = await octokit.repos.listCommits({
      owner,
      repo,
      sha: branch,
      per_page: limit
    });

    const commits = response.data.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      htmlUrl: c.html_url
    }));

    res.json(commits);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar commits: ' + err.message });
  }
});

// Cerrar una issue
app.post('/api/issues/:number/close', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { number } = req.params;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    const response = await octokit.issues.update({
      owner,
      repo,
      issue_number: parseInt(number),
      state: 'closed'
    });

    res.json({
      success: true,
      message: `Issue #${number} cerrada con éxito.`,
      htmlUrl: response.data.html_url
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cerrar la issue: ' + err.message });
  }
});

// Eliminar una rama
app.delete('/api/branches/:name', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { name } = req.params;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    await octokit.git.deleteRef({
      owner,
      repo,
      ref: `heads/${name}`
    });

    res.json({
      success: true,
      message: `Rama "${name}" eliminada correctamente de GitHub.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar la rama: ' + err.message });
  }
});

// Consultar reviews de un PR
app.get('/api/pulls/:number/reviews', async (req, res) => {
  try {
    const octokit = getOctokit();
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const { number } = req.params;

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
    }

    const response = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: parseInt(number)
    });

    const reviews = response.data.map(r => ({
      id: r.id,
      user: r.user.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submitted_at
    }));

    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar reviews del PR: ' + err.message });
  }
});

// Endpoint de flujo de trabajo automatizado completo (workflow)
app.post('/api/workflow', async (req, res) => {
  const octokit = getOctokit();
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!owner || !repo) {
    return res.status(400).json({ error: 'Configuración de repositorio incompleta.' });
  }

  const {
    branchName,
    fromBranch = process.env.GITHUB_BRANCH || 'main',
    filename,
    content,
    commitMessage,
    createPr = false,
    prTitle,
    prBody,
    mergePr = false,
    deleteBranch = false
  } = req.body;

  const steps = [];
  try {
    let currentSha = null;
    let targetBranch = fromBranch;

    // 1. Crear rama si se solicita y no es la base
    if (branchName && branchName !== fromBranch) {
      try {
        const baseRef = await octokit.git.getRef({
          owner,
          repo,
          ref: `heads/${fromBranch}`
        });
        const baseSha = baseRef.data.object.sha;

        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: baseSha
        });
        targetBranch = branchName;
        steps.push(`Creada rama "${branchName}" desde "${fromBranch}"`);
      } catch (branchErr) {
        if (branchErr.status === 422) {
          targetBranch = branchName;
          steps.push(`La rama "${branchName}" ya existía, usando la existente`);
        } else {
          throw new Error(`Fallo al crear la rama: ${branchErr.message}`);
        }
      }
    }

    // 2. Comprobar si el archivo ya existe para obtener su SHA en caso de actualización
    let fileSha = null;
    if (filename && content) {
      try {
        const fileRes = await octokit.repos.getContent({
          owner,
          repo,
          path: filename,
          ref: targetBranch
        });
        if (!Array.isArray(fileRes.data)) {
          fileSha = fileRes.data.sha;
        }
      } catch (e) {
        // Archivo nuevo
      }

      // Validar posts si están en la carpeta de posts
      const postsPath = process.env.GITHUB_POSTS_PATH || 'posts';
      if (filename.startsWith(postsPath)) {
        try {
          validatePostContent(path.basename(filename), content);
        } catch (valErr) {
          return res.status(400).json({ error: 'Validación Frontmatter fallida: ' + valErr.message });
        }
      }

      // Escribir el archivo
      const contentBuffer = Buffer.from(content, 'utf8').toString('base64');
      const params = {
        owner,
        repo,
        path: filename,
        message: commitMessage || `Update: ${filename}`,
        content: contentBuffer,
        branch: targetBranch
      };
      if (fileSha) params.sha = fileSha;

      const writeRes = await octokit.repos.createOrUpdateFileContents(params);
      currentSha = writeRes.data.commit.sha;
      steps.push(`Archivo "${filename}" guardado correctamente en la rama "${targetBranch}"`);
    }

    // 3. Crear Pull Request
    let prNumber = null;
    let prUrl = null;
    if (createPr && branchName && branchName !== fromBranch) {
      const response = await octokit.pulls.create({
        owner,
        repo,
        title: prTitle || `Merge: ${branchName} to ${fromBranch}`,
        head: branchName,
        base: fromBranch,
        body: prBody || 'Flujo automatizado por gestiona_github'
      });
      prNumber = response.data.number;
      prUrl = response.data.html_url;
      steps.push(`Creado Pull Request #${prNumber} ("${branchName}" -> "${fromBranch}")`);
    }

    // 4. Fusionar (Merge) el PR
    if (mergePr && prNumber) {
      const mergeRes = await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        commit_title: `Merge Pull Request #${prNumber} from workflow`
      });
      steps.push(`Fusionado Pull Request #${prNumber} en "${fromBranch}" (SHA: ${mergeRes.data.sha})`);

      // 5. Eliminar la rama si se solicita y fue fusionada
      if (deleteBranch && branchName && branchName !== fromBranch) {
        await octokit.git.deleteRef({
          owner,
          repo,
          ref: `heads/${branchName}`
        });
        steps.push(`Eliminada rama "${branchName}"`);
      }
    }

    res.json({
      success: true,
      steps,
      prNumber,
      prUrl,
      currentSha
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error en el flujo automatizado: ' + err.message,
      steps
    });
  }
});

// --- Endpoints de Git Local (Estructura de Microservicios) ---
const { exec } = require('child_process');

// Helper para obtener el path local de un proyecto
function getLocalProjectPath(projectName) {
  const rootPath = path.join(__dirname, '..');
  return path.resolve(rootPath, projectName);
}

// GET: Estado local de Git
app.get('/local/status/:projectName', (req, res) => {
  const { projectName } = req.params;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  exec('git rev-parse --is-inside-work-tree', { cwd: projectDir }, (err) => {
    if (err) {
      return res.json({ initialized: false });
    }

    exec('git branch --show-current', { cwd: projectDir }, (errBranch, stdoutBranch) => {
      const branch = stdoutBranch.trim() || 'master';

      exec('git status --porcelain', { cwd: projectDir }, (errStatus, stdoutStatus) => {
        const files = [];
        const lines = stdoutStatus.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          const statusChar = line.substring(0, 2).trim();
          const file = line.substring(3).trim();
          files.push({ file, status: statusChar });
        }
        res.json({ initialized: true, branch, files });
      });
    });
  });
});

// POST: Inicializar repositorio Git local
app.post('/local/init/:projectName', (req, res) => {
  const { projectName } = req.params;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  const command = 'git init && git config user.name "TaskForge Agent" && git config user.email "agent@taskforge.local" && git add . && git commit -m "Commit inicial de inicializacion"';
  
  exec(command, { cwd: projectDir }, (err, stdout, stderr) => {
    if (err) {
      console.error('Error al inicializar Git:', stderr);
      return res.status(500).json({ error: 'No se pudo inicializar Git en el proyecto.', details: stderr });
    }
    res.json({ success: true, message: 'Repositorio Git inicializado y primer commit creado.' });
  });
});

// GET: Obtener log local de commits
app.get('/local/log/:projectName', (req, res) => {
  const { projectName } = req.params;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  const logFormat = 'git log --max-count=20 --pretty=format:"%h|%an|%ar|%s"';
  
  exec(logFormat, { cwd: projectDir }, (err, stdout) => {
    if (err) {
      return res.json([]);
    }

    const commits = [];
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      commits.push({
        hash: parts[0],
        author: parts[1],
        date: parts[2],
        message: parts[3]
      });
    }
    res.json(commits);
  });
});

// GET: Obtener diff local
app.get('/local/diff/:projectName/:commitHash', (req, res) => {
  const { projectName, commitHash } = req.params;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  if (commitHash !== 'working-tree' && !/^[a-fA-F0-9]{4,40}$/.test(commitHash)) {
    return res.status(400).json({ error: 'Formato de commitHash inválido.' });
  }

  let command = '';
  if (commitHash === 'working-tree') {
    command = 'git diff HEAD';
  } else {
    command = `git show ${commitHash}`;
  }

  exec(command, { cwd: projectDir }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Error al recuperar la diferencia de Git.', details: err.message });
    }
    res.json({ diff: stdout });
  });
});

// POST: Revertir localmente
app.post('/local/revert/:projectName', (req, res) => {
  const { projectName } = req.params;
  const { commitHash } = req.body;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  if (commitHash !== 'working-tree' && !/^[a-fA-F0-9]{4,40}$/.test(String(commitHash || ''))) {
    return res.status(400).json({ error: 'Formato de commitHash inválido.' });
  }

  let command = '';
  if (commitHash === 'working-tree') {
    command = 'git reset --hard HEAD && git clean -fd';
  } else {
    command = `git revert --no-edit ${commitHash}`;
  }

  exec(command, { cwd: projectDir }, (err, stdout, stderr) => {
    if (err) {
      console.error('Error al revertir:', stderr);
      return res.status(500).json({ error: 'No se pudo revertir los cambios.', details: stderr });
    }
    res.json({ success: true, message: 'Cambios revertidos correctamente en el repositorio.' });
  });
});
// POST: Crear commit local
app.post('/local/commit/:projectName', (req, res) => {
  const { projectName } = req.params;
  const { message } = req.body;
  const projectDir = getLocalProjectPath(projectName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'El proyecto no existe.' });
  }

  if (!message) {
    return res.status(400).json({ error: 'El mensaje de commit es obligatorio.' });
  }

  const command = `git add . && git commit -m "${message.replace(/"/g, '\\"')}"`;

  exec(command, { cwd: projectDir }, (err, stdout, stderr) => {
    if (err) {
      console.error('Error al hacer commit:', stderr);
      return res.status(500).json({ error: 'No se pudo crear el commit local.', details: stderr });
    }
    res.json({ success: true, message: 'Commit creado correctamente en el repositorio.', output: stdout });
  });
});


// Endpoint de apagado (shutdown) para liberar recursos tras su uso
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('=================================================');
  console.log(` GitPublish CMS corriendo en: http://localhost:${PORT}`);
  console.log('=================================================');
});


