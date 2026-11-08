# api-design-assets

Microservicio encargado de proveer de forma automatizada recursos de diseño, paletas de colores premium, combinaciones tipográficas y mockups de maquetación HTML/CSS.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3500` (Gateway: `/api/design`)
- **Ruta física**: `IA_Infraestructura/api-design-assets/`
- **Requiere variables de entorno (.env)**: No

## ⚙️ Funciones Clave

1. **Catálogo de Paletas de Colores**: Entrega paletas de colores curadas (en formato CSS Custom Properties / variables) clasificadas por temas (`dark-premium`, `glassmorphism`, `minimalist-light`, `cyberpunk`).
2. **Recomendaciones Tipográficas**: Provee combinaciones óptimas de Google Fonts (fuentes principales y de soporte para legibilidad premium).
3. **Inyección de Mockups**: Genera código HTML y CSS completo de layouts modernos preconfigurados (ej. `dashboard-layout` o `landing-hero`), listos para ser inyectados en nuevos proyectos web.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/design/palette` | Obtiene variables CSS de una paleta por tema (parámetro `?theme=...`) |
| `GET` | `/api/design/fonts` | Retorna combinaciones de fuentes recomendadas |
| `POST` | `/api/design/mockup` | Genera una plantilla base de maquetación de componentes |
| `GET` | `/ping` | Healthcheck del servicio |
| `POST` | `/api/shutdown` | Cierre limpio del servidor |
