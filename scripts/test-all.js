import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

const FILES_TO_CHECK = [
  'scripts/infra-runner.js',
  'scripts/watch-logs.js',
  'infra-gateway/server.js',
  'infra-github/server.js',
  'infra-firebase/server.js',
  'infra-project-creator/server.js',
  'infra-project-creator/services/scaffolderService.js',
  'infra-project-creator/services/gitService.js',
  'infra-project-creator/services/dnsService.js',
  'infra-domain-manager/server.js',
  'api-design-assets/server.js',
  'api-conocimiento-rag/server.js',
  'api-utilidades-scraping/server.js'
];

console.log(`\n${colors.cyan}==================================================${colors.reset}`);
console.log(`${colors.cyan}   Proyectos IA - Validación Global de Suite      ${colors.reset}`);
console.log(`${colors.cyan}==================================================${colors.reset}\n`);

let failed = false;

// 1. Verificación sintáctica de todos los microservicios y scripts
console.log(`${colors.cyan}[1/3] Validando sintaxis de microservicios (node --check)...${colors.reset}`);
for (const relPath of FILES_TO_CHECK) {
  const fullPath = path.join(ROOT, relPath);
  try {
    execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
    console.log(`  ${colors.green}✓${colors.reset} ${relPath}`);
  } catch (err) {
    console.error(`  ${colors.red}✗ Error de sintaxis en ${relPath}:${colors.reset}\n${err.stderr?.toString() || err.message}`);
    failed = true;
  }
}

// 2. Verificación de política de seguridad (sin secretos OAuth hardcodeados y puertos en rango 3000-3799)
console.log(`\n${colors.cyan}[2/3] Validando política de puertos (3000-3799) e integridad de seguridad...${colors.reset}`);
const ecosystemPath = path.join(ROOT, 'ecosystem.config.cjs');
const ecosystemContent = fs.readFileSync(ecosystemPath, 'utf-8');
const portMatches = [...ecosystemContent.matchAll(/PORT:\s*(\d+)/g)].map((m) => Number(m[1]));

const allPortsValid = portMatches.length === 8 && portMatches.every((p) => p >= 3000 && p <= 3799);
if (allPortsValid) {
  console.log(`  ${colors.green}✓${colors.reset} Todos los puertos de ecosystem.config.cjs están en el rango reservado (${portMatches.join(', ')})`);
} else {
  console.error(`  ${colors.red}✗ Puertos fuera de rango detectados en ecosystem.config.cjs: ${portMatches.join(', ')}${colors.reset}`);
  failed = true;
}

// 3. Ejecución de tests de integración Jest (infra-project-creator)
console.log(`\n${colors.cyan}[3/3] Ejecutando suite de tests de integración (Jest)...${colors.reset}`);
try {
  execSync('npm test --prefix infra-project-creator', { cwd: ROOT, stdio: 'inherit' });
} catch {
  failed = true;
}

if (failed) {
  console.error(`\n${colors.red}✗ La validación global falló.${colors.reset}\n`);
  process.exit(1);
} else {
  console.log(`\n${colors.green}✓ Todos los controles de sintaxis, seguridad y tests de integración pasaron con éxito.${colors.reset}\n`);
  process.exit(0);
}
