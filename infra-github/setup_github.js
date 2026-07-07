/* eslint-disable */
const { Octokit } = require('@octokit/rest');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const token = process.env.GITHUB_TOKEN || '';
const projectPath = __dirname;
const repoName = 'github';

async function run() {
  console.log('1. Conectando con la API de GitHub usando el token...');
  const octokit = new Octokit({ auth: token });

  let username = '';
  try {
    const userRes = await octokit.users.getAuthenticated();
    username = userRes.data.login;
    console.log(`✓ Autenticado como el usuario de GitHub: ${username}`);
  } catch (err) {
    console.error(
      '❌ Error al autenticar con el token provisto. Verifica que sea válido.',
      err.message
    );
    process.exit(1);
  }

  console.log(`2. Verificando si el repositorio "${repoName}" ya existe en GitHub...`);
  let repoExists = false;
  try {
    await octokit.repos.get({ owner: username, repo: repoName });
    repoExists = true;
    console.log(`✓ El repositorio "${repoName}" ya existe en GitHub.`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`El repositorio "${repoName}" no existe. Se procederá a crearlo.`);
    } else {
      console.error('❌ Error al consultar el repositorio:', err.message);
      process.exit(1);
    }
  }

  if (!repoExists) {
    console.log(`3. Creando nuevo repositorio "${repoName}" en GitHub...`);
    try {
      await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description: 'Repositorio para GitPublish CMS y almacenamiento de posts',
        private: true, // Lo hacemos privado por seguridad
        auto_init: false
      });
      console.log(`✓ Repositorio privado "${repoName}" creado con éxito.`);
    } catch (err) {
      console.error('❌ Error al crear el repositorio:', err.message);
      process.exit(1);
    }
  }

  console.log('4. Inicializando Git local y subiendo el código del CMS...');
  try {
    // Configurar git local
    const gitDir = path.join(projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log('Inicializando nuevo repositorio git local...');
      execSync('git init', { cwd: projectPath, stdio: 'inherit' });
    } else {
      console.log('El repositorio git local ya estaba inicializado.');
    }

    // Configurar usuario por defecto si no lo está
    try {
      execSync('git config user.name', { cwd: projectPath });
    } catch {
      execSync(`git config user.name "${username}"`, { cwd: projectPath });
      execSync(`git config user.email "${username}@users.noreply.github.com"`, {
        cwd: projectPath
      });
    }

    // Añadir remoto
    const remoteUrl = `https://x-token-auth:${token}@github.com/${username}/${repoName}.git`;

    let hasRemote = false;
    try {
      const remotes = execSync('git remote', { cwd: projectPath }).toString();
      if (remotes.includes('origin')) {
        hasRemote = true;
      }
    } catch (e) {}

    if (hasRemote) {
      console.log('Actualizando URL del remoto origin...');
      execSync(`git remote set-url origin ${remoteUrl}`, { cwd: projectPath });
    } else {
      console.log('Añadiendo remoto origin...');
      execSync(`git remote add origin ${remoteUrl}`, { cwd: projectPath });
    }

    // Git add y commit
    console.log('Añadiendo archivos y creando commit inicial...');
    execSync('git add .', { cwd: projectPath });

    let hasChanges = false;
    try {
      const status = execSync('git status --porcelain', { cwd: projectPath }).toString().trim();
      if (status) hasChanges = true;
    } catch (e) {}

    if (hasChanges) {
      execSync('git commit -m "Commit inicial de GitPublish CMS"', { cwd: projectPath });
      console.log('✓ Cambios commiteados localmente.');
    } else {
      console.log('No hay cambios locales pendientes para commitear.');
    }

    // Cambiar a rama main y subir
    console.log('Subiendo código a GitHub (rama main)...');
    execSync('git branch -M main', { cwd: projectPath });
    execSync('git push -u origin main', { cwd: projectPath, stdio: 'inherit' });
    console.log('✓ Código subido a GitHub con éxito.');
  } catch (err) {
    console.error('❌ Error durante la configuración de Git local/remoto:', err.message);
    process.exit(1);
  }

  console.log('5. Actualizando archivo .env con el owner y repositorio detectados...');
  try {
    const envPath = path.join(projectPath, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Reemplazar o añadir
    const lines = envContent.split('\n');
    const newLines = [];

    const vars = {
      GITHUB_OWNER: username,
      GITHUB_REPO: repoName,
      GITHUB_BRANCH: 'main',
      GITHUB_POSTS_PATH: 'posts'
    };

    const keysProcessed = new Set();

    lines.forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        if (vars[key] !== undefined) {
          newLines.push(`${key}=${vars[key]}`);
          keysProcessed.add(key);
          return;
        }
      }
      newLines.push(line);
    });

    Object.entries(vars).forEach(([k, v]) => {
      if (!keysProcessed.has(k)) {
        newLines.push(`${k}=${v}`);
      }
    });

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
    console.log('✓ Archivo .env actualizado correctamente.');
  } catch (err) {
    console.error('❌ Error al actualizar el archivo .env:', err.message);
  }

  console.log('\n🎉 ¡PROCESO COMPLETADO CON ÉXITO! 🎉');
  console.log(
    `Tu proyecto GitPublish CMS está conectado y sincronizado con: https://github.com/${username}/${repoName}`
  );
}

run();
