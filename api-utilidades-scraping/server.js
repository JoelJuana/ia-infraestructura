import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
const PORT = process.env.PORT || process.env.SCRAPING_SERVICE_PORT || 3700;

app.use(cors());
app.use(express.json());

// Logger simple
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

/**
 * Formatea nodos inline (enlaces <a>, código <code>, negritas <strong>) dentro de un bloque.
 */
function formatInlineHtml($, elem, baseUrl) {
  const clone = $(elem).clone();

  clone.find('code').each((_, codeEl) => {
    const codeText = $(codeEl).text().trim();
    if (codeText) {
      $(codeEl).replaceWith(`\`${codeText}\``);
    }
  });

  clone.find('a[href]').each((_, linkEl) => {
    const label = $(linkEl).text().trim().replace(/\s+/g, ' ');
    let href = $(linkEl).attr('href') || '';
    if (!label || href.startsWith('javascript:') || href.startsWith('#')) {
      $(linkEl).replaceWith(label);
      return;
    }
    try {
      if (baseUrl && !href.startsWith('http')) {
        href = new URL(href, baseUrl).href;
      }
    } catch {
      // Conservar href original si falla la resolución
    }
    $(linkEl).replaceWith(`[${label}](${href})`);
  });

  return clone.text().trim().replace(/\s+/g, ' ');
}

/**
 * Convierte una tabla HTML <table> a formato Markdown GFM.
 */
function tableToMarkdown($, tableElem) {
  const rows = [];
  $(tableElem).find('tr').each((_, tr) => {
    const cells = [];
    $(tr).find('th, td').each((__, cell) => {
      const cellText = $(cell).text().trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');
      cells.push(cellText);
    });
    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const normalizeRow = (r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const headerLine = normalizeRow(rows[0]);
  const separatorLine = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const bodyLines = rows.slice(1).map(normalizeRow);

  return `\n${[headerLine, separatorLine, ...bodyLines].join('\n')}\n`;
}

// Helper para limpiar el HTML y convertirlo a un formato Markdown estructurado y legible
function htmlToMarkdown($, container, baseUrl) {
  let markdown = '';

  // Limpiar elementos no deseados de la zona a procesar
  container.find('script, style, iframe, noscript, svg, footer, nav, header, aside').remove();

  // Recorrer los elementos hijos relevantes
  container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table').each((_, elem) => {
    // Evitar duplicar elementos anidados dentro de tablas o pre
    if ($(elem).parents('table, pre').length > 0 && elem.tagName.toLowerCase() !== 'table') {
      return;
    }

    const tagName = elem.tagName.toLowerCase();

    if (tagName === 'table') {
      const mdTable = tableToMarkdown($, elem);
      if (mdTable) markdown += mdTable;
      return;
    }

    if (tagName === 'pre') {
      const rawCode = $(elem).text().trim();
      if (rawCode) {
        markdown += `\n\`\`\`\n${rawCode}\n\`\`\`\n`;
      }
      return;
    }

    const text = formatInlineHtml($, elem, baseUrl);
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
    }
  });

  return markdown.trim();
}

// --- Endpoints ---

// 1. Root: Informacion de la API
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: "Proyectos IA - API de Web Scraping & Extraccion",
      version: "1.1.0"
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

    // Convertir el HTML del contenedor principal a Markdown enriquecido
    const markdown = htmlToMarkdown($, mainContainer.first(), url);

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

// 3. GET: Ping healthcheck
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', service: 'api-utilidades-scraping', port: PORT });
});

// 4. POST: Shutdown
app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de Scraping...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

app.listen(PORT, () => {
  console.log(`⚡ API de Web Scraping & Extraccion activa en http://localhost:${PORT}`);
});
