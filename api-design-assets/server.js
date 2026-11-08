import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || process.env.DESIGN_ASSETS_PORT || 3500;

app.use(cors());
app.use(express.json());

// Logger simple para depuracion
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// Paletas de colores premium curadas
const PALETTES = {
  "dark-premium": {
    name: "Dark Premium",
    background: "#0d0e12",
    surface: "#161820",
    primary: "#6366f1", // Indigo
    secondary: "#a855f7", // Purple
    text: "#f3f4f6",
    muted: "#9ca3af",
    border: "#1f2937",
    glow: "rgba(99, 102, 241, 0.15)"
  },
  "glassmorphism": {
    name: "Glassmorphism Ocean",
    background: "linear-gradient(135deg, #0f172a, #1e1b4b)",
    surface: "rgba(255, 255, 255, 0.03)",
    primary: "#0ea5e9", // Sky
    secondary: "#2dd4bf", // Teal
    text: "#f8fafc",
    muted: "#64748b",
    border: "rgba(255, 255, 255, 0.08)",
    backdropFilter: "blur(12px)"
  },
  "minimalist-light": {
    name: "Pure Minimalist",
    background: "#fafafa",
    surface: "#ffffff",
    primary: "#18181b", // Zinc 900
    secondary: "#71717a", // Zinc 500
    text: "#09090b",
    muted: "#a1a1aa",
    border: "#e4e4e7",
    glow: "rgba(24, 24, 27, 0.05)"
  },
  "cyberpunk": {
    name: "Cyber Neon",
    background: "#05050a",
    surface: "#0c0c14",
    primary: "#ff007f", // Neon Rose
    secondary: "#00f0ff", // Cyan
    text: "#ffffff",
    muted: "#8a8a9d",
    border: "#202030",
    glow: "rgba(255, 0, 127, 0.25)"
  }
};

// Combinaciones premium de tipografia de Google Fonts
const FONTS = [
  {
    theme: "Modern Tech / SaaS",
    header: "Outfit",
    body: "Inter",
    link: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;600;700&display=swap"
  },
  {
    theme: "Premium / Luxury / Editorial",
    header: "Playfair Display",
    body: "Lora",
    link: "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;1,400&family=Playfair+Display:wght@500;700&display=swap"
  },
  {
    theme: "Clean / Minimalist",
    header: "Plus Jakarta Sans",
    body: "Plus Jakarta Sans",
    link: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap"
  }
];

// Layouts UI Premium en HTML/CSS inyectables
const LAYOUTS = {
  "dashboard-layout": {
    name: "Premium Admin Dashboard",
    css: `
body {
  margin: 0;
  font-family: 'Inter', sans-serif;
  background-color: #0b0c10;
  color: #c5c6c7;
}
.app-container {
  display: flex;
  height: 100vh;
}
.sidebar {
  width: 260px;
  background-color: #1f2833;
  border-right: 1px solid #2f3e46;
  padding: 24px;
}
.main-content {
  flex: 1;
  padding: 40px;
  overflow-y: auto;
}
.card {
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 24px;
  transition: all 0.3s ease;
}
.card:hover {
  transform: translateY(-2px);
  border-color: #66fcf1;
}
    `,
    html: `
<div class="app-container">
  <aside class="sidebar">
    <h2>Proyectos IA</h2>
    <nav>
      <ul>
        <li><a href="#" style="color: #66fcf1;">Inicio</a></li>
        <li><a href="#">Servicios</a></li>
        <li><a href="#">Configuración</a></li>
      </ul>
    </nav>
  </aside>
  <main class="main-content">
    <div class="card">
      <h3>Panel de Control</h3>
      <p>Bienvenido al dashboard centralizado de tu proyecto web.</p>
    </div>
  </main>
</div>
    `
  },
  "landing-hero": {
    name: "Ultra-Premium Hero Section",
    css: `
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
  text-align: center;
  background: radial-gradient(circle at center, #111827 0%, #030712 100%);
  padding: 20px;
}
.badge {
  background: rgba(99, 102, 241, 0.1);
  color: #818cf8;
  padding: 6px 12px;
  border-radius: 9999px;
  border: 1px solid rgba(99, 102, 241, 0.2);
  margin-bottom: 24px;
  font-size: 14px;
}
.title {
  font-size: 56px;
  font-weight: 800;
  color: #fff;
  margin: 0 0 16px 0;
  letter-spacing: -0.025em;
  background: linear-gradient(135deg, #fff 0%, #9ca3af 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.desc {
  font-size: 20px;
  color: #9ca3af;
  max-width: 600px;
  line-height: 1.6;
}
.btn-primary {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  border: none;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.3);
  transition: all 0.2s ease;
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 20px -3px rgba(99, 102, 241, 0.4);
}
    `,
    html: `
<section class="hero">
  <div class="badge">Novedades de la Suite</div>
  <h1 class="title">Diseño del Futuro</h1>
  <p class="desc">Crea y despliega interfaces sofisticadas con IA integrada y microservicios locales.</p>
  <button class="btn-primary">Empezar Ahora</button>
</section>
    `
  }
};

// --- Endpoints ---

// 1. Root: Informacion de la API
app.get('/', (req, res) => {
  res.json({
    ok: true,
    data: {
      name: "Proyectos IA - API de Diseño & Assets",
      version: "1.0.0",
      endpoints: {
        palette: "/palette",
        fonts: "/fonts",
        mockup: "/mockup"
      }
    },
    message: "Servicio de diseño en linea."
  });
});

// 2. GET: Paletas de colores
app.get('/palette', (req, res) => {
  res.json({
    ok: true,
    data: PALETTES,
    message: "Paletas premium curadas recuperadas correctamente."
  });
});

// 3. GET: Fuentes recomendadas
app.get('/fonts', (req, res) => {
  res.json({
    ok: true,
    data: FONTS,
    message: "Tipografias recomendadas recuperadas correctamente."
  });
});

// 4. POST: Generar mockup / estructura UI
app.post('/mockup', (req, res) => {
  const { type } = req.body;
  
  if (!type || !LAYOUTS[type]) {
    return res.status(404).json({
      ok: false,
      error: "LAYOUT_NOT_FOUND",
      message: `El mockup '${type}' no existe. Opciones disponibles: ${Object.keys(LAYOUTS).join(', ')}`
    });
  }

  res.json({
    ok: true,
    data: LAYOUTS[type],
    message: `Layout '${type}' generado con exito.`
  });
});

// 5. GET: Ping healthcheck
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// 6. POST: Shutdown
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Servidor apagándose...' });
  console.log('Recibida petición de apagado. Cerrando servidor de Design Assets...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

app.listen(PORT, () => {
  console.log(`⚡ API de Diseno & Assets activa en http://localhost:${PORT}`);
});
