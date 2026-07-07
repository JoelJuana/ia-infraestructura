import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4500;

app.use(cors());
app.use(express.json());

// Logger simple
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// Helper para limpiar el HTML y convertirlo a un formato Markdown basico y legible
function htmlToMarkdown($, container) {
  let markdown = '';
  
  // Limpiar elementos no deseados de la zona a procesar
  container.find('script, style, iframe, noscript, footer, nav, header, aside').remove();

  // Recorrer los elementos hijos de forma estructurada
  container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre').each((_, elem) => {
    const tagName = elem.tagName.toLowerCase();
    const text = $(elem).text().trim().replace(/\s+/g, ' ');

    if (!text) return;

    if (tagName.startsWith('h')) {
      const level = parseInt(tagName.substring(1), 10);
      markdown += `\n${'#'.repeat(level)} ${text}\n`;
    } else if (tagName === 'p') {
      markdown += `\n${text}\n`;
    } else if (tagName === 'li') {
      markdown += `* ${text}\n`;
    } else if (tagName === 'blockquote') {
      markdown += `\n> ${text}\n`;
    } else if (tagName === 'pre') {
      markdown += `\n\`\`\`\n${$(elem).text().trim()}\n\`\`\`\n`;
    }
  });

  return markdown.trim();
}

// --- Endpoints ---

// 1. Root: Informacion de la API
app.get('/', (req, res) => {
  res.json({
    ok: true,
    data: {
      name: "Proyectos IA - API de Web Scraping & Extraccion",
      version: "1.0.0"
    },
    message: "Servicio de web scraping en linea."
  });
});

// 2. POST: Extraer informacion limpia de una URL
app.post('/extract', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_URL",
      message: "Se requiere una URL valida que comience con http/https."
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "FETCH_FAILED",
        message: `Fallo al descargar la URL. HTTP Code: ${response.status}`
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extraer metadatos basicos
    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    const author = $('meta[name="author"]').attr('content') || '';

    // Intentar encontrar el contenedor principal del contenido para omitir basura de headers/footers
    let mainContainer = $('article, main, .content, .post, #content');
    if (mainContainer.length === 0) {
      mainContainer = $('body');
    }

    // Convertir el HTML del contenedor principal a Markdown
    const markdown = htmlToMarkdown($, mainContainer.first());

    res.json({
      ok: true,
      data: {
        url,
        title,
        metadata: {
          description,
          author
        },
        contentMarkdown: markdown
      },
      message: "Scraping y extraccion de texto completados con exito."
    });

  } catch (error) {
    console.error(`Error al hacer scraping de ${url}:`, error);
    res.status(500).json({
      ok: false,
      error: "SCRAPING_FAILED",
      message: error.name === 'AbortError' 
        ? "La peticion de descarga web expiro tras 10 segundos de inactividad." 
        : `Error de servidor al hacer scraping: ${error.message}`
    });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ API de Web Scraping & Extraccion activa en http://localhost:${PORT}`);
});
