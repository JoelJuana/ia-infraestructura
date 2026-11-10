import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import shared from '../packages/shared/index.cjs';

const {
  isAllowedLocalOrigin,
  isPrivateOrReservedIp,
  validateSafeExternalUrl,
  writeEnvFileSafe,
  readLogTail
} = shared;

// Configurar entorno aislado de pruebas antes de importar servidores
process.env.NODE_ENV = 'test';
const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-infra-tests-'));
process.env.RAG_STORE_PATH = path.join(tmpTestDir, 'rag-store-test.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

/**
 * Levanta temporalmente una app Express en un puerto efímero de loopback para pruebas HTTP reales.
 */
function startEphemeralServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

describe('1. Seguridad y Utilidades Compartidas (@ia-infra/shared)', () => {
  it('permite orígenes locales (localhost / 127.0.0.1) y bloquea dominios externos', () => {
    assert.equal(isAllowedLocalOrigin(undefined), true);
    assert.equal(isAllowedLocalOrigin('http://localhost:3000'), true);
    assert.equal(isAllowedLocalOrigin('http://127.0.0.1:5173'), true);
    assert.equal(isAllowedLocalOrigin('https://evil.example.com'), false);
    assert.equal(isAllowedLocalOrigin('http://localhost.evil.com'), false);
  });

  it('identifica rangos IP privados, loopback, link-local y metadata cloud', () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
    assert.equal(isPrivateOrReservedIp('172.16.10.1'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.50'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
  });

  it('bloquea intentos de SSRF hacia localhost, IPs internas y esquemas no HTTP', async () => {
    const loop1 = await validateSafeExternalUrl('http://127.0.0.1:3100/api/config', { resolveDns: false });
    assert.equal(loop1.safe, false);

    const loop2 = await validateSafeExternalUrl('http://localhost:3000/api/health', { resolveDns: false });
    assert.equal(loop2.safe, false);

    const meta = await validateSafeExternalUrl('http://169.254.169.254/latest/meta-data/', { resolveDns: false });
    assert.equal(meta.safe, false);

    const fileScheme = await validateSafeExternalUrl('file:///C:/Windows/win.ini', { resolveDns: false });
    assert.equal(fileScheme.safe, false);

    const publicIp = await validateSafeExternalUrl('https://1.1.1.1/', { resolveDns: false });
    assert.equal(publicIp.safe, true);
  });

  it('escribe archivos .env de forma atómica preservando comentarios y leyendo cola de logs', () => {
    const envFile = path.join(tmpTestDir, '.env.test');
    fs.writeFileSync(envFile, '# Comentario inicial\nEXISTING_KEY=valor1\n', 'utf8');

    writeEnvFileSafe(envFile, { NEW_KEY: 'valor2', EXISTING_KEY: 'actualizado' });
    const content = fs.readFileSync(envFile, 'utf8');
    assert.match(content, /# Comentario inicial/);
    assert.match(content, /EXISTING_KEY=actualizado/);
    assert.match(content, /NEW_KEY=valor2/);

    const logFile = path.join(tmpTestDir, 'sample.log');
    const lines = Array.from({ length: 100 }, (_, i) => `Linea ${i + 1}`).join('\n');
    fs.writeFileSync(logFile, lines, 'utf8');
    const tail = readLogTail(logFile, 5, 1024);
    assert.equal(tail, 'Linea 96\nLinea 97\nLinea 98\nLinea 99\nLinea 100');
  });
});

describe('2. Motor RAG Okapi BM25 e Indexación de Directorios (api-conocimiento-rag)', () => {
  let ctx;
  let flushRagSync;

  before(async () => {
    const { app, saveStoreSync } = await import('../api-conocimiento-rag/server.js');
    flushRagSync = saveStoreSync;
    ctx = await startEphemeralServer(app);
  });

  after(async () => {
    flushRagSync();
    await ctx.close();
  });

  it('indexa documentos, prioriza términos con mayor IDF en BM25 y soporta indexación de carpetas', async () => {
    // Limpiar store de prueba
    await fetch(`${ctx.baseUrl}/store`, { method: 'DELETE' });

    // Indexar 3 documentos donde "arquitectura" aparece en todos pero "snapdragon" es específico de uno
    const docs = [
      {
        title: 'guia-general-1',
        content: 'La arquitectura del sistema define componentes modulares reutilizables para aplicaciones empresariales modernas.'
      },
      {
        title: 'guia-general-2',
        content: 'Toda arquitectura moderna requiere observabilidad centralizada y arquitectura limpia en sus capas.'
      },
      {
        title: 'optimizacion-arm64',
        content: 'La arquitectura sobre procesadores Snapdragon ARM64 evita emulación Prism ejecutando binarios nativos.'
      }
    ];

    for (const d of docs) {
      const res = await fetch(`${ctx.baseUrl}/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      assert.equal(res.status, 200);
    }

    const searchRes = await fetch(`${ctx.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'arquitectura snapdragon', limit: 3 })
    });
    const searchJson = await searchRes.json();
    assert.equal(searchJson.ok, true);
    assert.equal(searchJson.data[0].title, 'optimizacion-arm64');

    // Probar indexación por lotes de carpeta
    const docsDir = path.join(tmpTestDir, 'batch-docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'manual-fiscal.md'),
      '# Fiscalidad AEAT\n\nEl modelo 303 permite liquidar trimestralmente el impuesto sobre el valor añadido en España.',
      'utf8'
    );

    const dirRes = await fetch(`${ctx.baseUrl}/index-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directoryPath: docsDir, titlePrefix: 'skills' })
    });
    const dirJson = await dirRes.json();
    assert.equal(dirJson.ok, true);
    assert.equal(dirJson.data.filesIndexed, 1);

    const fiscalSearch = await fetch(`${ctx.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'modelo 303 trimestralmente' })
    });
    const fiscalJson = await fiscalSearch.json();
    assert.equal(fiscalJson.data[0].title, 'skills/manual-fiscal.md');
  });
});

describe('3. Protección Anti-SSRF y Conversión Markdown (api-utilidades-scraping)', () => {
  let ctx;
  let convertHtmlFn;

  before(async () => {
    const mod = await import('../api-utilidades-scraping/server.js');
    convertHtmlFn = mod.convertHtmlFragmentToMarkdown;
    ctx = await startEphemeralServer(mod.app);
  });

  after(async () => {
    await ctx.close();
  });

  it('rechaza peticiones SSRF dirigidas a puertos internos o IPs privadas con HTTP 403', async () => {
    const res = await fetch(`${ctx.baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:3100/api/config' })
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'SSRF_BLOCKED');
  });

  it('convierte tablas HTML, enlaces relativos y bloques de código a Markdown GFM limpio', () => {
    const sampleHtml = `
      <main>
        <h1>Título Principal</h1>
        <p>Visita la <a href="/docs/inicio">documentación oficial</a> usando <code>npm run start</code>.</p>
        <table>
          <tr><th>Servicio</th><th>Puerto</th></tr>
          <tr><td>Gateway</td><td>3000</td></tr>
        </table>
      </main>
    `;
    const md = convertHtmlFn(sampleHtml, 'https://ejemplo.com');
    assert.match(md, /# Título Principal/);
    assert.match(md, /\[documentación oficial\]\(https:\/\/ejemplo\.com\/docs\/inicio\)/);
    assert.match(md, /`npm run start`/);
    assert.match(md, /\| Servicio \| Puerto \|/);
  });
});

describe('4. Encriptación Autenticada GCM, Diseño y Blindaje CORS Local', () => {
  let designCtx;
  let dnsMod;
  let dnsCtx;

  before(async () => {
    const designMod = await import('../api-design-assets/server.js');
    designCtx = await startEphemeralServer(designMod.app);

    const dnsImported = await import('../infra-domain-manager/server.js');
    dnsMod = dnsImported.default || dnsImported;
    dnsCtx = await startEphemeralServer(dnsMod.app);
  });

  after(async () => {
    await designCtx.close();
    await dnsCtx.close();
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  });

  it('cifra y descifra tokens con AES-256-GCM autenticado y detecta manipulación', () => {
    const secret = 'cf_secret_token_123456789';
    const encrypted = dnsMod.encrypt(secret);
    assert.ok(encrypted.startsWith('gcm:'));
    assert.equal(dnsMod.decrypt(encrypted), secret);

    // Manipular un byte del ciphertext debe invalidar el AuthTag y devolver cadena vacía
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('aa') ? 'bb' : 'aa');
    assert.equal(dnsMod.decrypt(tampered), '');
  });

  it('devuelve paletas, mockups y telemetría de memoria en /ping, rechazando orígenes remotos maliciosos', async () => {
    const pingRes = await fetch(`${designCtx.baseUrl}/ping`);
    const pingData = await pingRes.json();
    assert.equal(pingData.status, 'ok');
    assert.equal(typeof pingData.memoryMB, 'number');

    const palRes = await fetch(`${designCtx.baseUrl}/palette`);
    assert.equal(palRes.status, 200);

    // Simular petición desde un sitio externo en el navegador
    const blockedRes = await fetch(`${dnsCtx.baseUrl}/api/config`, {
      headers: { Origin: 'https://sitio-malicioso.org' }
    });
    assert.equal(blockedRes.status, 403);
  });
});
