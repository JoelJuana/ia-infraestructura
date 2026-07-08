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
const PORT = process.env.PORT || 4400;

app.use(cors());
app.use(express.json());

// Logger simple
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// Almacenamiento en memoria de fragmentos (chunks) indexados
let documentStore = [];

// Intentar cargar la base de datos de conocimiento persistente
try {
  if (fs.existsSync(STORE_PATH)) {
    const rawData = fs.readFileSync(STORE_PATH, 'utf-8');
    documentStore = JSON.parse(rawData);
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

// Helper para limpiar y tokenizar texto
function tokenize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Eliminar acentos
    .replace(/[^a-z0-9\s]/g, "") // Eliminar puntuacion
    .split(/\s+/)
    .filter(t => t.length > 2); // Omitir stop words muy cortas
}

// Helper para calcular la coincidencia de texto (Score TF-IDF simplificado)
function scoreChunk(queryTokens, chunkTokens, chunkText) {
  let score = 0;
  
  // 1. Coincidencia de tokens individuales
  queryTokens.forEach(token => {
    const count = chunkTokens.filter(t => t === token).length;
    if (count > 0) {
      score += count * 1.5; // Frecuencia del token (TF)
    }
  });

  // 2. Coincidencias de frases exactas (Bonus de relevancia)
  const cleanQuery = queryTokens.join(' ');
  const cleanText = tokenize(chunkText).join(' ');
  if (cleanText.includes(cleanQuery)) {
    score += 10;
  }

  return score;
}

// --- Endpoints ---

// 1. Root: Informacion de la API
app.get('/', (req, res) => {
  res.json({
    ok: true,
    data: {
      name: "Proyectos IA - API de Conocimiento & RAG",
      version: "1.0.0",
      totalIndexedChunks: documentStore.length
    },
    message: "Servicio de RAG en linea."
  });
});

// 2. POST: Indexar nuevo texto / archivo
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
    // Fragmentar el contenido en parrafos (chunks) de tamano moderado
    const paragraphs = content.split(/\n\s*\n+/);
    const newChunks = [];

    paragraphs.forEach((p, idx) => {
      const trimmed = p.trim();
      if (!trimmed || trimmed.length < 20) return; // Omitir parrafos vacios o muy cortos

      const tokens = tokenize(trimmed);
      const chunkId = `${Date.now()}-${idx}`;

      newChunks.push({
        id: chunkId,
        title,
        text: trimmed,
        tokens,
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
        totalStoreChunks: documentStore.length
      },
      message: "Documento fragmentado e indexado con exito."
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

    // Calcular la puntuacion de cada fragmento
    const scored = documentStore.map(chunk => {
      const score = scoreChunk(queryTokens, chunk.tokens, chunk.text);
      return { ...chunk, score };
    });

    // Filtrar fragmentos con score > 0 y ordenar descendentemente
    const results = scored
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Omitir tokens en la respuesta final para ahorrar ancho de banda
    const cleanResults = results.map(({ tokens, ...rest }) => rest);

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

// 4. DELETE: Limpiar el store en memoria (para pruebas)
app.delete('/store', (req, res) => {
  documentStore = [];
  saveStore();
  res.json({
    ok: true,
    message: "Base de conocimientos RAG restablecida correctamente."
  });
});

// 5. GET: Ping healthcheck
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// 6. POST: Shutdown
app.post('/api/shutdown', (req, res) => {
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
