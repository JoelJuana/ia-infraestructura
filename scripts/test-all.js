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
  'packages/shared/index.cjs',
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
  'api-utilidades-scraping/server.js',
  'tests/infra-suite.test.js'
];

console.log(`\n${colors.cyan}==================================================${colors.reset}`);
console.log(`${colors.cyan}   Proyectos IA - Validación Global de Suite      ${colors.reset}`);
console.log(`${colors.cyan}==================================================${colors.reset}\n`);

let failed = false;

// 1. Verificación sintáctica de todos los microservicios y módulos compartidos
console.log(`${colors.cyan}[1/4] Validando sintaxis de microservicios y librerías (node --check)...${colors.reset}`);
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

// 2. Verificación de política de seguridad y arquitectura ARM64
console.log(`\n${colors.cyan}[2/4] Validando política de puertos (3000-3799), seguridad y optimización ARM64...${colors.reset}`);
const ecosystemPath = path.join(ROOT, 'ecosystem.config.cjs');
const ecosystemContent = fs.readFileSync(ecosystemPath, 'utf-8');
const portMatches = [...ecosystemContent.matchAll(/PORT:\s*(\d+)/g)].map((m) => Number(m[1]));

const allPortsValid = portMatches.length === 8 && portMatches.every((p) => p >= 3000 && p <= 3799);
if (allPortsValid) {
  console.log(`  ${colors.green}✓${colors.reset} Puertos de ecosystem.config.cjs en rango reservado (${portMatches.join(', ')})`);
} else {
  console.error(`  ${colors.red}✗ Puertos fuera de rango detectados en ecosystem.config.cjs: ${portMatches.join(', ')}${colors.reset}`);
  failed = true;
}

const runnerContent = fs.readFileSync(path.join(ROOT, 'scripts/infra-runner.js'), 'utf-8');
if (!runnerContent.includes('wscript.exe') && !runnerContent.includes('.vbs')) {
  console.log(`  ${colors.green}✓${colors.reset} Runner ARM64 libre de procesos legacy VBScript/WScript`);
} else {
  console.error(`  ${colors.red}✗ Se detectó uso legacy de VBScript/wscript.exe en infra-runner.js${colors.reset}`);
  failed = true;
}

const fbServerContent = fs.readFileSync(path.join(ROOT, 'infra-firebase/server.js'), 'utf-8');
if (!fbServerContent.includes('console.log(`Comando: ${cmd}`)')) {
  console.log(`  ${colors.green}✓${colors.reset} Credenciales protegidas contra volcado accidental en logs de Firebase`);
} else {
  console.error(`  ${colors.red}✗ Fuga potencial de FIREBASE_TOKEN en logs detectada en infra-firebase/server.js${colors.reset}`);
  failed = true;
}

// 3. Ejecución de suite de tests nativos (node:test) para Shared, RAG BM25, Scraping SSRF, DNS GCM y Diseño
console.log(`\n${colors.cyan}[3/4] Ejecutando tests unitarios y de seguridad de microservicios (node:test)...${colors.reset}`);
try {
  execFileSync(process.execPath, ['--test', path.join(ROOT, 'tests/infra-suite.test.js')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch {
  failed = true;
}

// 4. Ejecución de tests de integración Jest (infra-project-creator)
console.log(`\n${colors.cyan}[4/4] Ejecutando suite de tests de integración de scaffolding (Jest)...${colors.reset}`);
try {
  execSync('npm test --prefix infra-project-creator', { cwd: ROOT, stdio: 'inherit' });
} catch {
  failed = true;
}

if (failed) {
  console.error(`\n${colors.red}✗ La validación global falló.${colors.reset}\n`);
  process.exit(1);
} else {
  console.log(`\n${colors.green}✓ Todos los controles de sintaxis, seguridad ARM64 y suites de tests pasaron con éxito.${colors.reset}\n`);
  process.exit(0);
}
