const path = require('path');
const fs = require('fs');

// Cargar .env del propio proyecto crear-proyecto
const localEnvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(localEnvPath)) {
  require('dotenv').config({ path: localEnvPath });
}

const PORT = parseInt(process.env.PORT || '3300', 10);
const defaultProyectosDir = path.resolve(__dirname, '..', '..', '..', 'IA_Proyectos');
const BASE_PROYECTOS_DIR = process.env.BASE_PROYECTOS_DIR || (fs.existsSync(defaultProyectosDir) ? defaultProyectosDir : path.resolve(__dirname, '..', '..'));

// Intentar cargar variables de entorno del CMS de GitHub para autenticación e Issues
const githubEnvPath = path.resolve(__dirname, '..', '..', 'infra-github', '.env');
let githubToken = process.env.GITHUB_TOKEN;
let githubOwner = process.env.GITHUB_OWNER;
let githubRepo = process.env.GITHUB_REPO;

if (fs.existsSync(githubEnvPath)) {
  try {
    const dotenv = require('dotenv');
    const parsed = dotenv.parse(fs.readFileSync(githubEnvPath));
    if (!githubToken) githubToken = parsed.GITHUB_TOKEN;
    if (!githubOwner) githubOwner = parsed.GITHUB_OWNER;
    if (!githubRepo) githubRepo = parsed.GITHUB_REPO;
  } catch (e) {
    // Ignorar si falla la lectura opcional
  }
}

module.exports = {
  PORT,
  BASE_PROYECTOS_DIR,
  GITHUB_TOKEN: githubToken,
  GITHUB_OWNER: githubOwner,
  GITHUB_REPO: githubRepo
};
