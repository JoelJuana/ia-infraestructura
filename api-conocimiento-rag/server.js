import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import shared from '../packages/shared/index.cjs';

const {
  LOCAL_HOST,
  createLocalCorsOptions,
  localSecurityMiddleware,
  getProcessMetrics
} = shared;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PATH = process.env.RAG_STORE_PATH || path.resolve(__dirname, 'data', 'store.json');

const app = express();
const PORT = Number(process.env.PORT || process.env.RAG_SERVICE_PORT || 3600);

// Parámetros estándar de ranking Okapi BM25
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOP_WORDS = new Set([
  'del', 'las', 'los', 'una', 'uno', 'unos', 'unas', 'por', 'para', 'con',
  'sin', 'sobre', 'entre', 'hasta', 'desde', 'como', 'mas', 'pero', 'sus',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'que',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were'
]);

app.use(localSecurityMiddleware);
app.use(cors(createLocalCorsOptions()));
app.use(express.json({ limit: '15mb' }));

// Logger simple
app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

/**
 * Limpia y tokeniza texto eliminando acentos, puntuación y stop-words triviales.
 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// Almacenamiento en memoria de fragmentos (chunks) e índices BM25 precalculados
let documentStore = [];
let corpusDocFreq = new Map();
let avgChunkLength = 1;
let pendingSaveTimer = null;

/**
 * Recalcula las estadísticas globales de frecuencia documental (IDF) y longitud media para BM25.
 */
function rebuildCorpusStats() {
  const df = new Map();
  let totalTokens = 0;

  for (const chunk of documentStore) {
    const tokens = chunk.tokens || [];
    totalTokens += tokens.length;

    const uniqueInChunk = new Set(tokens);
    for (const token of uniqueInChunk) {
      df.set(token, (df.get(token) || 0) + 1);
    }

    if (!Array.isArray(chunk.titleTokens)) {
      chunk.titleTokens = tokenize(chunk.title || '');
    }
    if (!chunk.termFreq) {
      const tf = Object.create(null);
      for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
      }
      chunk.termFreq = tf;
    }
  }

  corpusDocFreq = df;
  avgChunkLength = documentStore.length > 0 ? Math.max(1, totalTokens / documentStore.length) : 1;
}

/**
 * Prepara un objeto chunk listo para almacenamiento y búsqueda rápida.
 */
function buildChunkRecord({ id, title, text, updatedAt, metadata }) {
  const tokens = tokenize(text);
  const titleTokens = tokenize(title);
  const termFreq = Object.create(null);
  for (const t of tokens) {
    termFreq[t] = (termFreq[t] || 0) + 1;
  }

  return {
    id,
    title,
    text,
    tokens,
    titleTokens,
    termFreq,
    cleanText: tokens.join(' '),
    updatedAt,
    metadata
  };
}

/**
 * Serializa únicamente los campos persistibles para mantener store.json compacto en disco.
 */
function serializeStore() {
  const compact = documentStore.map(({ id, title, text, tokens, updatedAt, metadata }) => ({
    id,
    title,
    text,
    tokens,
    updatedAt,
    metadata
  }));
  return JSON.stringify(compact);
}

/**
 * Guardado síncrono atómico (usado únicamente durante apagado limpio).
 */
function saveStoreSync() {
  try {
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer);
      pendingSaveTimer = null;
    }
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, serializeStore(), 'utf-8');
    fs.renameSync(tmpPath, STORE_PATH);
    return true;
  } catch (err) {
    console.error('Error al guardar la base de conocimiento en disco (sync):', err.message);
    return false;
  }
}

/**
 * Guardado asíncrono atómico con debounce ligero para no bloquear el event loop en ráfagas de indexación.
 */
function scheduleSaveStore() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }
  pendingSaveTimer = setTimeout(async () => {
    pendingSaveTimer = null;
    try {
      const dir = path.dirname(STORE_PATH);
      await fs.promises.mkdir(dir, { recursive: true });
      const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, serializeStore(), 'utf-8');
      await fs.promises.rename(tmpPath, STORE_PATH);
    } catch (err) {
      console.error('Error al persistir store RAG asíncronamente:', err.message);
    }
  }, 80);
  pendingSaveTimer.unref?.();
}

// Cargar base de conocimiento existente al iniciar
try {
  if (fs.existsSync(STORE_PATH)) {
    const rawData = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (Array.isArray(parsed)) {
      documentStore = parsed.map((chunk) =>
        buildChunkRecord({
          id: chunk.id,
          title: chunk.title,
          text: chunk.text,
          updatedAt: chunk.updatedAt || null,
          metadata: chunk.metadata || {}
        })
      );
      rebuildCorpusStats();
    }
    console.log(`Base de conocimiento RAG cargada desde disco: ${documentStore.length} chunks.`);
  } else {
    console.log('No se detectó base de conocimiento persistente en disco. Iniciando vacía.');
  }
} catch (err) {
  console.error('Error al cargar la base de conocimiento desde disco:', err.message);
}

/**
 * Calcula la puntuación Okapi BM25 real + bonus ponderado por título y coincidencia exacta de frase.
 */
function scoreChunkBM25(queryTokens, cleanQuery, chunk) {
  const N = documentStore.length;
  if (N === 0) return 0;

  let score = 0;
  const docLen = chunk.tokens.length || 1;
  const tfMap = chunk.termFreq || {};
  const titleTokens = chunk.titleTokens || [];

  for (const token of queryTokens) {
    const df = corpusDocFreq.get(token) || 0;
    // Fórmula IDF de Okapi BM25 suavizada (siempre positiva)
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const tf = tfMap[token] || 0;

    if (tf > 0) {
      const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgChunkLength));
      score += idf * ((tf * (BM25_K1 + 1)) / norm) * 2.5;
    }

    if (titleTokens.includes(token)) {
      score += 2.0 + idf * 1.5;
    }
  }

  if (cleanQuery.length > 3 && chunk.cleanText.includes(cleanQuery)) {
    score += 8.0;
  }

  return Number(score.toFixed(4));
}

/**
 * Indexa un documento en memoria (sin disparar guardado aún, para reutilizar en lotes).
 */
function upsertDocumentInMemory(title, content, metadata = {}) {
  const previousLength = documentStore.length;
  documentStore = documentStore.filter((chunk) => chunk.title !== title);
  const replacedChunks = previousLength - documentStore.length;

  const paragraphs = String(content).split(/\n\s*\n+/);
  const newChunks = [];
  const nowIso = new Date().toISOString();
  const baseTs = Date.now();

  paragraphs.forEach((p, idx) => {
    const trimmed = p.trim();
    if (!trimmed || trimmed.length < 20) return;

    newChunks.push(
      buildChunkRecord({
        id: `${baseTs}-${idx}`,
        title,
        text: trimmed,
        updatedAt: nowIso,
        metadata: { ...metadata, paragraphIndex: idx }
      })
    );
  });

  documentStore.push(...newChunks);
  return { chunksCreated: newChunks.length, replacedChunks };
}

// --- Endpoints ---

// 1. Root: Información de la API
app.get('/', (_req, res) => {
  const uniqueDocs = new Set(documentStore.map((c) => c.title)).size;
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA - API de Conocimiento & RAG',
      version: '1.2.0',
      rankingEngine: 'Okapi BM25 + Phrase Boost',
      totalDocuments: uniqueDocs,
      totalIndexedChunks: documentStore.length,
      vocabularySize: corpusDocFreq.size
    },
    message: 'Servicio de RAG en linea.'
  });
});

// 1.5 GET: Listar documentos únicos indexados
app.get('/documents', (_req, res) => {
  const docsMap = new Map();
  for (const chunk of documentStore) {
    const existing = docsMap.get(chunk.title);
    if (!existing) {
      docsMap.set(chunk.title, {
        title: chunk.title,
        chunksCount: 1,
        metadata: chunk.metadata || {},
        updatedAt: chunk.updatedAt || null
      });
    } else {
      existing.chunksCount += 1;
    }
  }

  res.json({
    ok: true,
    data: Array.from(docsMap.values()),
    totalDocuments: docsMap.size,
    totalChunks: documentStore.length
  });
});

// 2. POST: Indexar nuevo texto / archivo (con Upsert automático por title)
app.post('/index', (req, res) => {
  const { title, content, metadata = {} } = req.body;

  if (!title || !content) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_FIELDS',
      message: 'Se requiere el titulo (title) y contenido (content) del documento.'
    });
  }

  try {
    const { chunksCreated, replacedChunks } = upsertDocumentInMemory(title, content, metadata);
    rebuildCorpusStats();
    scheduleSaveStore();

    res.json({
      ok: true,
      data: {
        documentTitle: title,
        chunksCreated,
        replacedChunks,
        totalStoreChunks: documentStore.length
      },
      message: replacedChunks > 0
        ? `Documento actualizado (upsert): ${replacedChunks} chunks reemplazados por ${chunksCreated} nuevos.`
        : 'Documento fragmentado e indexado con exito.'
    });
  } catch (error) {
    console.error('Error al indexar documento:', error);
    res.status(500).json({
      ok: false,
      error: 'INDEXING_FAILED',
      message: 'Error de servidor al procesar el documento.'
    });
  }
});

// 2.5 POST: Indexar recursivamente una carpeta local de documentación (.md, .mdx, .txt)
app.post('/index-directory', async (req, res) => {
  const {
    directoryPath,
    extensions = ['.md', '.mdx', '.txt'],
    titlePrefix = ''
  } = req.body;

  if (!directoryPath || typeof directoryPath !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_DIRECTORY',
      message: 'El campo directoryPath es obligatorio.'
    });
  }

  const resolvedRoot = path.resolve(directoryPath);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DIRECTORY',
      message: `El directorio especificado no existe o no es válido: ${resolvedRoot}`
    });
  }

  const allowedExt = new Set(
    (Array.isArray(extensions) ? extensions : ['.md', '.mdx', '.txt']).map((e) =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
    )
  );
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', '.astro', '.next', '.infra-logs']);

  let filesIndexed = 0;
  let chunksCreatedTotal = 0;

  async function walkDir(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          await walkDir(path.join(currentDir, entry.name));
        }
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExt.has(ext)) continue;

      const fullFilePath = path.join(currentDir, entry.name);
      const stats = await fs.promises.stat(fullFilePath);
      if (stats.size > 2 * 1024 * 1024) continue; // Omitir archivos > 2MB

      const content = await fs.promises.readFile(fullFilePath, 'utf-8');
      const relPath = path.relative(resolvedRoot, fullFilePath).replace(/\\/g, '/');
      const docTitle = titlePrefix ? `${titlePrefix}/${relPath}` : relPath;

      const { chunksCreated } = upsertDocumentInMemory(docTitle, content, {
        sourcePath: fullFilePath,
        relativePath: relPath
      });
      filesIndexed += 1;
      chunksCreatedTotal += chunksCreated;
    }
  }

  try {
    await walkDir(resolvedRoot);
    rebuildCorpusStats();
    scheduleSaveStore();

    res.json({
      ok: true,
      data: {
        directory: resolvedRoot,
        filesIndexed,
        chunksCreated: chunksCreatedTotal,
        totalStoreChunks: documentStore.length
      },
      message: `Directorio indexado con éxito: ${filesIndexed} archivos procesados (${chunksCreatedTotal} chunks).`
    });
  } catch (error) {
    console.error('Error al indexar directorio en RAG:', error);
    res.status(500).json({
      ok: false,
      error: 'DIRECTORY_INDEXING_FAILED',
      message: `Fallo al indexar directorio: ${error.message}`
    });
  }
});

// 3. POST: Buscar pasajes relevantes (Retrieval BM25)
app.post('/search', (req, res) => {
  const { query, limit = 3 } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY',
      message: 'La consulta (query) es obligatoria.'
    });
  }

  try {
    const queryTokens = Array.from(new Set(tokenize(query)));

    if (queryTokens.length === 0) {
      return res.json({
        ok: true,
        data: [],
        message: 'No se encontraron tokens validos para buscar.'
      });
    }

    const cleanQuery = tokenize(query).join(' ');

    const scored = [];
    for (const chunk of documentStore) {
      const score = scoreChunkBM25(queryTokens, cleanQuery, chunk);
      if (score > 0) {
        const { tokens, titleTokens, termFreq, cleanText, ...publicFields } = chunk;
        scored.push({ ...publicFields, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const cleanResults = scored.slice(0, Math.max(1, Number(limit) || 3));

    res.json({
      ok: true,
      data: cleanResults,
      message: `Busqueda completada. Se recuperaron ${cleanResults.length} pasajes relevantes.`
    });
  } catch (error) {
    console.error('Error al buscar en RAG:', error);
    res.status(500).json({
      ok: false,
      error: 'SEARCH_FAILED',
      message: 'Error de servidor al buscar en RAG.'
    });
  }
});

// 3.5 DELETE: Eliminar un documento específico por su título
app.delete('/documents/:title', (req, res) => {
  const targetTitle = decodeURIComponent(req.params.title || '');
  const beforeCount = documentStore.length;
  documentStore = documentStore.filter((c) => c.title !== targetTitle);
  const removedChunks = beforeCount - documentStore.length;

  if (removedChunks === 0) {
    return res.status(404).json({
      ok: false,
      error: 'DOCUMENT_NOT_FOUND',
      message: `No se encontró ningún documento con el título "${targetTitle}".`
    });
  }

  rebuildCorpusStats();
  scheduleSaveStore();
  res.json({
    ok: true,
    data: { title: targetTitle, removedChunks, totalStoreChunks: documentStore.length },
    message: `Documento "${targetTitle}" eliminado (${removedChunks} chunks).`
  });
});

// 4. DELETE: Limpiar el store completo
app.delete('/store', (_req, res) => {
  documentStore = [];
  rebuildCorpusStats();
  scheduleSaveStore();
  res.json({
    ok: true,
    message: 'Base de conocimientos RAG restablecida correctamente.'
  });
});

// 5. GET: Ping healthcheck
app.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api-conocimiento-rag',
    port: PORT,
    chunks: documentStore.length,
    ...getProcessMetrics()
  });
});

let serverInstance = null;

// 6. POST: Shutdown
app.post('/api/shutdown', (_req, res) => {
  saveStoreSync();
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de RAG...');
  setTimeout(() => {
    if (serverInstance) serverInstance.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  }, 300);
});

app.use((err, _req, res, next) => {
  if (err && err.status === 403) {
    return res.status(403).json({ ok: false, error: 'CORS_BLOCKED', message: err.message });
  }
  return next(err);
});

if (process.env.NODE_ENV !== 'test') {
  serverInstance = app.listen(PORT, LOCAL_HOST, () => {
    console.log(`API de Conocimiento & RAG activa en http://${LOCAL_HOST}:${PORT}`);
  });
}

export { app, saveStoreSync };
