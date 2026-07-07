const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const crypto = require("crypto");

// Intentar cargar variables de entorno locales, y si no, del proyecto github
const localEnvPath = path.join(__dirname, ".env");
const cmsEnvPath = path.join(__dirname, "..", "github", ".env");

if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else if (fs.existsSync(cmsEnvPath)) {
  dotenv.config({ path: cmsEnvPath });
  // Copiar del CMS al local por comodidad inicial
  try {
    fs.copyFileSync(cmsEnvPath, localEnvPath);
    console.log("✓ Copiado archivo .env desde github");
  } catch (e) {
    console.warn("⚠️ No se pudo copiar el .env de github:", e.message);
  }
} else {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || process.env.CLOUDFLARE_PORT || 3400;

app.use(cors());
app.use(express.json());


// Helper para guardar variables en el archivo .env
function writeEnvFile(vars) {
  const envPath = path.join(__dirname, ".env");
  let currentEnv = {};

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    envContent.split("\n").forEach((line) => {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        if (key) currentEnv[key] = val;
      }
    });
  }

  // Mezclar nuevas variables
  const updatedEnv = { ...currentEnv, ...vars };

  // Re-escribir archivo
  const newContent = Object.entries(updatedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  fs.writeFileSync(envPath, newContent, "utf8");

  // Actualizar process.env en tiempo de ejecución
  Object.entries(vars).forEach(([k, v]) => {
    process.env[k] = v;
  });
}

// --- SISTEMA DE ENCRIPTACIÓN DE CREDENCIALES (AES-256-CBC) ---
const ALGORITHM = "aes-256-cbc";

function getEncryptionKey() {
  let key = process.env.ENCRYPTION_KEY;
  if (!key) {
    // Generar una clave de 32 bytes persistente local en el .env si no existe
    const generatedKey = crypto.randomBytes(32).toString("hex");
    writeEnvFile({ ENCRYPTION_KEY: generatedKey });
    key = generatedKey;
  }
  return Buffer.from(key, "hex");
}

function encrypt(text) {
  if (!text) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

function decrypt(text) {
  if (!text) return "";
  if (!text.includes(":")) return text; // Fallback si no está encriptado todavía
  try {
    const key = getEncryptionKey();
    const parts = text.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("⚠️ Error al desencriptar credencial:", err.message);
    return text;
  }
}

// Enmascarar credenciales sensibles
function maskString(str) {
  if (!str) return "";
  if (str.length <= 8) return "...";
  return `${str.substring(0, 4)}...${str.substring(str.length - 4)}`;
}

// --- ENDPOINTS ---

// Health check para skill de Gemini
app.get("/ping", (req, res) => {
  res.json({ status: "ok", service: "gestion-dominios" });
});

// Obtener configuración actual
app.get("/api/config", (req, res) => {
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  res.json({
    hasToken: !!token,
    maskedToken: maskString(token),
    zoneId: process.env.CLOUDFLARE_ZONE_ID || "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    baseDomain: process.env.CLOUDFLARE_BASE_DOMAIN || "",
  });
});

// Guardar nueva configuración
app.post("/api/config", (req, res) => {
  const { token, zoneId, accountId, baseDomain } = req.body;

  try {
    const varsToUpdate = {};
    if (token !== undefined && !token.includes("...")) {
      varsToUpdate.CLOUDFLARE_API_TOKEN = encrypt(token);
    }
    if (zoneId !== undefined) varsToUpdate.CLOUDFLARE_ZONE_ID = zoneId;
    if (accountId !== undefined) varsToUpdate.CLOUDFLARE_ACCOUNT_ID = accountId;
    if (baseDomain !== undefined) varsToUpdate.CLOUDFLARE_BASE_DOMAIN = baseDomain;

    writeEnvFile(varsToUpdate);
    res.json({ success: true, message: "Configuración guardada correctamente." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 1. Validar disponibilidad y precio de nombres de dominio
app.get("/api/domains/check", async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ success: false, error: "Debe especificar un dominio a validar." });
  }

  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token || !accountId) {
    // Si no hay configuración de Cloudflare, devolvemos un fallback informativo simulado para pruebas de UI
    return res.json({
      success: true,
      isSimulated: true,
      message: "Mostrando datos simulados por falta de credenciales de Cloudflare.",
      result: {
        domain: domain,
        available: true,
        purchase_price: "$10.99",
        renewal_price: "$10.99",
        supported_tld: true,
      }
    });
  }

  try {
    // Llamada oficial a Cloudflare Registrar / Domains Search API
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: domain,
          exclude_disallowed: true
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      // Fallback si la llamada real falla por permisos del token (ej. Registrar requiere permisos de nivel de cuenta)
      const errorMsg = data.errors && data.errors[0] ? data.errors[0].message : "Error desconocido en Cloudflare";
      console.warn("⚠️ Error en llamada real de Cloudflare Registrar:", errorMsg);
      
      // Simulamos la disponibilidad usando chequeo básico para permitir desarrollo fluido
      const cleanDomain = domain.toLowerCase().trim();
      const isAvailable = !cleanDomain.includes("google") && !cleanDomain.includes("cloudflare") && !cleanDomain.includes("github");
      
      return res.json({
        success: true,
        isSimulated: true,
        message: `API Real reportó: "${errorMsg}". Mostrando simulación de disponibilidad.`,
        result: {
          domain: domain,
          available: isAvailable,
          purchase_price: "$12.50 USD",
          renewal_price: "$12.50 USD",
          supported_tld: cleanDomain.endsWith(".com") || cleanDomain.endsWith(".net") || cleanDomain.endsWith(".org") || cleanDomain.endsWith(".dev"),
        }
      });
    }

    // Estructura oficial devuelta por Cloudflare Registrar (se adapta a lo que retorne)
    res.json({
      success: true,
      isSimulated: false,
      result: data.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Obtener todos los registros DNS de la zona
app.get("/api/dns/records", async (req, res) => {
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!token || !zoneId) {
    return res.json({
      success: true,
      isSimulated: true,
      message: "Variables de entorno incompletas (requiere CLOUDFLARE_API_TOKEN y CLOUDFLARE_ZONE_ID).",
      records: [
        {
          id: "sim-1",
          type: "CNAME",
          name: `ejemplo.${process.env.CLOUDFLARE_BASE_DOMAIN || "tus-proyectos.com"}`,
          content: "joeljuana.github.io",
          proxied: true,
          ttl: 1,
          locked: false
        }
      ]
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : "Error al obtener DNS de Cloudflare"
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      records: data.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Crear registro DNS de tipo CNAME
app.post("/api/dns/cname", async (req, res) => {
  const { name, content, proxied } = req.body;
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const baseDomain = process.env.CLOUDFLARE_BASE_DOMAIN || "tus-proyectos.com";

  if (!name || !content) {
    return res.status(400).json({ success: false, error: "Los campos 'name' y 'content' son obligatorios." });
  }

  // Asegurar que el nombre tenga el dominio base si no lo tiene
  let fullRecordName = name;
  if (!name.endsWith(baseDomain)) {
    fullRecordName = `${name}.${baseDomain}`;
  }

  if (!token || !zoneId) {
    return res.json({
      success: true,
      isSimulated: true,
      message: "Registro creado en modo simulación (credenciales incompletas).",
      record: {
        id: `sim-${Date.now()}`,
        type: "CNAME",
        name: fullRecordName,
        content: content,
        proxied: proxied !== false,
        ttl: 1
      }
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "CNAME",
          name: fullRecordName,
          content: content,
          ttl: 1, // 1 es Automático en Cloudflare
          proxied: proxied !== false, // CNAME con proxy por defecto
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : "Error al crear registro DNS"
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      record: data.result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Eliminar registro DNS
app.delete("/api/dns/records/:id", async (req, res) => {
  const { id } = req.params;
  const token = decrypt(process.env.CLOUDFLARE_API_TOKEN);
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (id.startsWith("sim-")) {
    return res.json({
      success: true,
      isSimulated: true,
      message: "Registro simulado eliminado del listado local."
    });
  }

  if (!token || !zoneId) {
    return res.status(400).json({ success: false, error: "Faltan credenciales de Cloudflare para eliminar registros." });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      return res.status(response.status).json({
        success: false,
        error: data.errors && data.errors[0] ? data.errors[0].message : "Error al eliminar registro DNS"
      });
    }

    res.json({
      success: true,
      isSimulated: false,
      message: "Registro DNS eliminado correctamente."
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint de apagado (shutdown) para liberar recursos tras su uso
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🌐 Gestión Dominios corriendo en: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});

