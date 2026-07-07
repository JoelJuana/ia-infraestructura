const fs = require('fs');
const path = require('path');
const markdownlint = require('markdownlint');

const postsDir = path.join(__dirname, '..', 'posts');

function validatePost(filePath) {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  if (!filename.endsWith('.md') && !filename.endsWith('.markdown')) {
    console.error(`❌ [ERROR] ${filename}: Extensión inválida. Debe ser .md o .markdown.`);
    return false;
  }

  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    console.error(
      `❌ [ERROR] ${filename}: No tiene un encabezado Frontmatter válido delimitado por "---".`
    );
    return false;
  }

  const yamlBlock = match[1];
  const metadata = {};
  yamlBlock.split('\n').forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts.slice(1).join(':').trim();
      // Eliminar comillas
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.substring(1, val.length - 1);
      }
      metadata[key] = val;
    }
  });

  if (!metadata.title || metadata.title.trim() === '') {
    console.error(`❌ [ERROR] ${filename}: Falta el campo requerido "title" en los metadatos.`);
    return false;
  }

  if (!metadata.date || metadata.date.trim() === '') {
    console.error(`❌ [ERROR] ${filename}: Falta el campo requerido "date" en los metadatos.`);
    return false;
  } else {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(metadata.date.trim())) {
      console.error(
        `❌ [ERROR] ${filename}: El campo "date" tiene un formato inválido (${metadata.date}). Debe ser AAAA-MM-DD.`
      );
      return false;
    }
  }

  // Validación adicional con markdownlint para advertencias de estilo de redacción
  try {
    const lintOptions = {
      files: [filePath],
      config: {
        default: true,
        'line-length': false, // No limitar la longitud de las líneas
        'no-inline-html': false // Permitir tags HTML si se necesitan
      }
    };
    const lintResult = markdownlint.sync(lintOptions);
    const lintResultStr = lintResult.toString();
    if (lintResultStr) {
      console.warn(
        `⚠️ [ESTILO] ${filename}: Problemas de formato Markdown detectados:\n${lintResultStr}\n`
      );
    }
  } catch (lintErr) {
    console.warn(`⚠️ [ESTILO] No se pudo ejecutar markdownlint: ${lintErr.message}`);
  }

  console.log(`✓ [VÁLIDO] ${filename}`);
  return true;
}

function run() {
  console.log('Iniciando validación de posts...');

  if (!fs.existsSync(postsDir)) {
    console.log(
      `No se encontró el directorio de posts (${postsDir}). Creando uno vacío para las pruebas...`
    );
    fs.mkdirSync(postsDir, { recursive: true });
    // Crear un post de ejemplo válido para que el workflow no falle inicialmente si no hay posts
    const samplePostContent = `---\ntitle: "Mi primer post"\ndate: "${new Date().toISOString().split('T')[0]}"\nstatus: "published"\n---\n\nEste es un post de ejemplo.`;
    fs.writeFileSync(path.join(postsDir, 'ejemplo-inicial.md'), samplePostContent, 'utf8');
  }

  const files = fs.readdirSync(postsDir);
  const markdownFiles = files.filter(f => f.endsWith('.md') || f.endsWith('.markdown'));

  if (markdownFiles.length === 0) {
    console.log('No se encontraron archivos Markdown para validar.');
    process.exit(0);
  }

  let allValid = true;
  markdownFiles.forEach(file => {
    const isValid = validatePost(path.join(postsDir, file));
    if (!isValid) allValid = false;
  });

  if (allValid) {
    console.log('\n🎉 ¡Todos los posts son válidos!');
    process.exit(0);
  } else {
    console.error('\n❌ Se encontraron errores de validación en algunos posts.');
    process.exit(1);
  }
}

run();
