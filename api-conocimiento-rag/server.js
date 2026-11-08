import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PATH = path.resolve(__dirname, 'data', 'store.json');

const app = express();
const PORT = process.env.PORT || process.env.RAG_SERVICE_PORT || 3600;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Logger simple
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// Helper para limpiar y tokenizar texto
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Eliminar acentos
    .replace(/[^a-z0-9\s]/g, " ")   // Reemplazar puntuación por espacio
    .split(/\s+/)
    .filter((t) => t.length > 2);   // Omitir stop words muy cortas
}

// Almacenamiento en memoria de fragmentos (chunks) indexados
let documentStore = [];

// Intentar cargar la base de datos de conocimiento persistente
try {
  if (fs.existsSync(STORE_PATH)) {
    const rawData = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (Array.isArray(parsed)) {
      documentStore = parsed.map((chunk) => ({
        ...chunk,
        tokens: Array.isArray(chunk.tokens) ? chunk.tokens : tokenize(chunk.text),
        cleanText: chunk.cleanText || (Array.isArray(chunk.tokens) ? chunk.tokens.join(' ') : tokenize(chunk.text).join(' '))
      }));
    }
    console.log(`✓ Base de conocimiento RAG cargada desde disco: ${documentStore.length} chunks.`);
  } else {
    console.log('ℹ No se detecto base de conocimiento persistente en disco. Iniciando vacia.');
  }
} catch (err) {
  console.error('⚠️ Error al cargar la base de conocimiento desde disco:', err.message);
}

// Helper para persistir el store en disco
function saveStore() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(documentStore, null, 2), 'utf-8');
    console.log(`✓ Base de conocimiento RAG guardada en disco: ${documentStore.length} chunks.`);
    return true;
  } catch (err) {
    console.error('⚠️ Error al guardar la base de conocimiento en disco:', err.message);
    return false;
  }
}

// Helper para calcular la coincidencia de texto (Score TF-IDF + BM25 ligero con precomputo)
function scoreChunk(queryTokens, cleanQuery, chunk) {
  let score = 0;
  const chunkTokens = chunk.tokens || [];
  const titleTokens = tokenize(chunk.title || '');

  // 1. Coincidencia de tokens individuales en contenido y título
  for (const token of queryTokens) {
    let count = 0;
    for (let i = 0; i < chunkTokens.length; i++) {
      if (chunkTokens[i] === token) count++;
    }
    if (count > 0) {
      // Saturación logarítmica para evitar sesgo por chunks largos
      score += (1 + Math.log(count)) * 2.0;
    }
    if (titleTokens.includes(token)) {
      score += 3.0; // Bonus si el término aparece en el título del documento
    }
  }

  // 2. Coincidencias de frases exactas usando cleanText precalculado
  const cleanText = chunk.cleanText || chunkTokens.join(' ');
  if (cleanQuery.length > 3 && cleanText.includes(cleanQuery)) {
    score += 10;
  }

  return Number(score.toFixed(3));
}

// --- Endpoints ---

// 1. Root: Informacion de la API
app.get('/', (_req, res) => {
  const uniqueDocs = new Set(documentStore.map((c) => c.title)).size;
  res.json({
    ok: true,
    data: {
      name: "Proyectos IA - API de Conocimiento & RAG",
      version: "1.1.0",
      totalDocuments: uniqueDocs,
      totalIndexedChunks: documentStore.length
    },
    message: "Servicio de RAG en linea."
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
      error: "MISSING_FIELDS",
      message: "Se requiere el titulo (title) y contenido (content) del documento."
    });
  }

  try {
    // Upsert: eliminar fragmentos previos del mismo documento para evitar duplicados
    const previousLength = documentStore.length;
    documentStore = documentStore.filter((chunk) => chunk.title !== title);
    const replacedChunks = previousLength - documentStore.length;

    // Fragmentar el contenido en párrafos de tamaño moderado
    const paragraphs = String(content).split(/\n\s*\n+/);
    const newChunks = [];
    const nowIso = new Date().toISOString();

    paragraphs.forEach((p, idx) => {
      const trimmed = p.trim();
      if (!trimmed || trimmed.length < 20) return;

      const tokens = tokenize(trimmed);
      const chunkId = `${Date.now()}-${idx}`;

      newChunks.push({
        id: chunkId,
        title,
        text: trimmed,
        tokens,
        cleanText: tokens.join(' '),
        updatedAt: nowIso,
        metadata: { ...metadata, paragraphIndex: idx }
      });
    });

    documentStore.push(...newChunks);
    saveStore();

    res.json({
      ok: true,
      data: {
        documentTitle: title,
        chunksCreated: newChunks.length,
        replacedChunks,
        totalStoreChunks: documentStore.length
      },
      message: replacedChunks > 0
        ? `Documento actualizado (upsert): ${replacedChunks} chunks reemplazados por ${newChunks.length} nuevos.`
        : "Documento fragmentado e indexado con exito."
    });
  } catch (error) {
    console.error("Error al indexar documento:", error);
    res.status(500).json({
      ok: false,
      error: "INDEXING_FAILED",
      message: "Error de servidor al procesar el documento."
    });
  }
});

// 3. POST: Buscar pasajes relevantes (Retrieval)
app.post('/search', (req, res) => {
  const { query, limit = 3 } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_QUERY",
      message: "La consulta (query) es obligatoria."
    });
  }

  try {
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0) {
      return res.json({
        ok: true,
        data: [],
        message: "No se encontraron tokens validos para buscar."
      });
    }

    const cleanQuery = queryTokens.join(' ');

    const scored = documentStore.map((chunk) => {
      const score = scoreChunk(queryTokens, cleanQuery, chunk);
      return { ...chunk, score };
    });

    const results = scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit) || 3);

    // Omitir campos internos de indexación en la respuesta final
    const cleanResults = results.map(({ tokens, cleanText, ...rest }) => rest);

    res.json({
      ok: true,
      data: cleanResults,
      message: `Busqueda completada. Se recuperaron ${cleanResults.length} pasajes relevantes.`
    });
  } catch (error) {
    console.error("Error al buscar en RAG:", error);
    res.status(500).json({
      ok: false,
      error: "SEARCH_FAILED",
      message: "Error de servidor al buscar en RAG."
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
      error: "DOCUMENT_NOT_FOUND",
      message: `No se encontró ningún documento con el título "${targetTitle}".`
    });
  }

  saveStore();
  res.json({
    ok: true,
    data: { title: targetTitle, removedChunks, totalStoreChunks: documentStore.length },
    message: `Documento "${targetTitle}" eliminado (${removedChunks} chunks).`
  });
});

// 4. DELETE: Limpiar el store completo
app.delete('/store', (_req, res) => {
  documentStore = [];
  saveStore();
  res.json({
    ok: true,
    message: "Base de conocimientos RAG restablecida correctamente."
  });
});

// 5. GET: Ping healthcheck
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', service: 'api-conocimiento-rag', port: PORT });
});

// 6. POST: Shutdown
app.post('/api/shutdown', (_req, res) => {
  saveStore();
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de RAG...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

app.listen(PORT, () => {
  console.log(`⚡ API de Conocimiento & RAG activa en http://localhost:${PORT}`);
});
