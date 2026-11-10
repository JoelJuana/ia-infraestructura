import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import shared from '../packages/shared/index.cjs';

const {
  LOCAL_HOST,
  createLocalCorsOptions,
  localSecurityMiddleware,
  getProcessMetrics,
  validateSafeExternalUrl
} = shared;

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || process.env.SCRAPING_SERVICE_PORT || 3700);
const MAX_HTML_BYTES = Number(process.env.SCRAPE_MAX_BYTES || 5 * 1024 * 1024); // 5 MB máx.
const MAX_REDIRECTS = 4;

app.use(localSecurityMiddleware);
app.use(cors(createLocalCorsOptions()));
app.use(express.json({ limit: '1mb' }));

// Logger simple
app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

/**
 * Descarga el cuerpo de una respuesta HTTP respetando un tamaño máximo estricto en bytes.
 */
async function readResponseTextBounded(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    const err = new Error(`El recurso remoto supera el límite permitido (${Math.round(maxBytes / 1048576)} MB).`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const err = new Error(`El recurso remoto supera el límite permitido (${Math.round(maxBytes / 1048576)} MB).`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      const err = new Error(`Descarga cancelada: supera el límite de ${Math.round(maxBytes / 1048576)} MB.`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Realiza fetch validando cada redirección contra SSRF (hosts privados, loopback, metadata).
 */
async function fetchSafeExternalHtml(initialUrl, signal) {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateSafeExternalUrl(currentUrl);
    if (!check.safe) {
      const err = new Error(check.reason);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }

    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5'
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        const err = new Error('Redirección HTTP sin cabecera Location.');
        err.code = 'INVALID_REDIRECT';
        throw err;
      }
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  const err = new Error(`Demasiadas redirecciones HTTP (máximo ${MAX_REDIRECTS}).`);
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

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

  container.find('script, style, iframe, noscript, svg, footer, nav, header, aside').remove();

  container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, table').each((_, elem) => {
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

// 1. Root: Información de la API
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    data: {
      name: 'Proyectos IA - API de Web Scraping & Extraccion',
      version: '1.2.0',
      maxPayloadMB: Math.round(MAX_HTML_BYTES / 1048576)
    },
    message: 'Servicio de web scraping en linea.'
  });
});

// 2. POST: Extraer información limpia de una URL pública (con protección anti-SSRF y límite de RAM)
app.post('/extract', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_URL',
      message: 'Se requiere una URL valida que comience con http/https.'
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let response;
    let finalUrl;
    try {
      const result = await fetchSafeExternalHtml(url, controller.signal);
      response = result.response;
      finalUrl = result.finalUrl;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: 'FETCH_FAILED',
        message: `Fallo al descargar la URL. HTTP Code: ${response.status}`
      });
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isAllowedType =
      !contentType ||
      contentType.includes('text/') ||
      contentType.includes('html') ||
      contentType.includes('xml') ||
      contentType.includes('json');

    if (!isAllowedType) {
      return res.status(415).json({
        ok: false,
        error: 'UNSUPPORTED_CONTENT_TYPE',
        message: `Tipo de contenido no soportado para extracción de texto: ${contentType}`
      });
    }

    const html = await readResponseTextBounded(response, MAX_HTML_BYTES);

    // Si es texto plano o Markdown directo, devolver sin parsear HTML
    if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
      return res.json({
        ok: true,
        data: {
          url: finalUrl,
          title: finalUrl.split('/').pop() || finalUrl,
          metadata: { description: '', author: '' },
          contentMarkdown: html.trim()
        },
        message: 'Extracción de texto plano completada con éxito.'
      });
    }

    const $ = cheerio.load(html);

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    const author = $('meta[name="author"]').attr('content') || '';

    let mainContainer = $('article, main, .content, .post, #content');
    if (mainContainer.length === 0) {
      mainContainer = $('body');
    }

    const markdown = htmlToMarkdown($, mainContainer.first(), finalUrl);

    res.json({
      ok: true,
      data: {
        url: finalUrl,
        title,
        metadata: {
          description,
          author
        },
        contentMarkdown: markdown
      },
      message: 'Scraping y extraccion de texto completados con exito.'
    });
  } catch (error) {
    if (error.code === 'SSRF_BLOCKED') {
      return res.status(403).json({
        ok: false,
        error: 'SSRF_BLOCKED',
        message: error.message
      });
    }
    if (error.code === 'PAYLOAD_TOO_LARGE') {
      return res.status(413).json({
        ok: false,
        error: 'PAYLOAD_TOO_LARGE',
        message: error.message
      });
    }

    console.error(`Error al hacer scraping de ${url}:`, error.message);
    res.status(500).json({
      ok: false,
      error: 'SCRAPING_FAILED',
      message: error.name === 'AbortError'
        ? 'La peticion de descarga web expiro tras 10 segundos de inactividad.'
        : `Error de servidor al hacer scraping: ${error.message}`
    });
  }
});

// 3. GET: Ping healthcheck
app.get('/ping', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api-utilidades-scraping',
    port: PORT,
    ...getProcessMetrics()
  });
});

let serverInstance = null;

// 4. POST: Shutdown
app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de Scraping...');
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
    console.log(`API de Web Scraping & Extraccion activa en http://${LOCAL_HOST}:${PORT}`);
  });
}

/**
 * Convierte un documento o fragmento HTML completo a Markdown GFM usando Cheerio.
 */
function convertHtmlFragmentToMarkdown(rawHtml, baseUrl = '') {
  const $ = cheerio.load(rawHtml);
  let container = $('article, main, .content, .post, #content');
  if (container.length === 0) {
    container = $('body');
  }
  return htmlToMarkdown($, container.first(), baseUrl);
}

export { app, htmlToMarkdown, convertHtmlFragmentToMarkdown };
