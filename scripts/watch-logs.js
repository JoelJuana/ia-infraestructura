import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, '.infra-logs');

console.log(`\x1b[35m==================================================\x1b[0m`);
console.log(`\x1b[35m      Monitor de Logs de Infraestructura Local     \x1b[0m`);
console.log(`\x1b[35m==================================================\x1b[0m`);
console.log(`Vigilando cambios en: \x1b[90m${LOGS_DIR}\x1b[0m\n`);

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const colors = {
  'infra-gateway': '\x1b[36m', // Cyan
  'infra-github': '\x1b[32m',  // Verde
  'infra-firebase': '\x1b[33m',// Amarillo
  'infra-project-creator': '\x1b[35m', // Magenta
  'infra-domain-manager': '\x1b[34m', // Azul
  'api-design-assets': '\x1b[95m', // Rosa claro
  'api-conocimiento-rag': '\x1b[96m', // Cyan claro
  'api-utilidades-scraping': '\x1b[90m', // Gris
  reset: '\x1b[0m'
};

const fileSizes = {};

function watchFile(filename) {
  const filePath = path.join(LOGS_DIR, filename);
  const serviceName = filename.replace('.log', '');
  const color = colors[serviceName] || colors.reset;

  if (fs.existsSync(filePath)) {
    fileSizes[filename] = fs.statSync(filePath).size;
  } else {
    fileSizes[filename] = 0;
  }

  // watchFile es más confiable en Windows frente a redirecciones de logs
  fs.watchFile(filePath, { interval: 250 }, (curr, prev) => {
    if (curr.size > prev.size) {
      try {
        const fd = fs.openSync(filePath, 'r');
        const length = curr.size - prev.size;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, prev.size);
        fs.closeSync(fd);

        const newText = buffer.toString('utf-8');
        const lines = newText.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            console.log(`${color}[${serviceName}]\x1b[0m ${line}`);
          }
        }
      } catch (err) {
        // Ignorar errores temporales si el archivo se bloquea momentáneamente
      }
    }
    fileSizes[filename] = curr.size;
  });
}

const logFiles = [
  'infra-gateway.log', 'infra-github.log', 'infra-firebase.log',
  'infra-project-creator.log', 'infra-domain-manager.log',
  'api-design-assets.log', 'api-conocimiento-rag.log',
  'api-utilidades-scraping.log'
];

logFiles.forEach(file => {
  const filePath = path.join(LOGS_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf-8');
  }
  watchFile(file);
});
