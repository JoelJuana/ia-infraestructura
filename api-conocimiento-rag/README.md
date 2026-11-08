# api-conocimiento-rag

Microservicio local encargado de la indexación, fragmentación (chunking) y búsqueda semántica mediante coincidencia de texto (motor de RAG local simplificado) para la base de conocimiento de los agentes de IA.

## 📋 Especificaciones Técnicas

- **Puerto de red**: `3600` (Gateway: `/api/rag`)
- **Ruta física**: `IA_Infraestructura/api-conocimiento-rag/`
- **Persistencia**: Guarda su base de conocimientos local en `data/store.json` (ignorado en Git).
- **Requiere variables de entorno (.env)**: Sí (Configuración del servidor de RAG si es requerida).

## ⚙️ Funciones Clave

1. **Fragmentación Automatizada (Chunking)**: Divide documentos extensos por párrafos moderados y descarta stop-words cortas para mejorar la precisión.
2. **Coincidencia Semántica (Relevancia TF-IDF)**: Calcula coincidencias de palabras clave, similitud de tokens y coincidencia exacta de frases para calificar los fragmentos con un score numérico.
3. **Persistencia en Disco**: Guarda de forma transparente y estructurada la base de datos de conocimiento indexada en un archivo local JSON.

## 📡 Endpoints del Servicio

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Retorna metadatos de la API y el número total de chunks indexados |
| `POST` | `/index` | Registra e indexa un nuevo documento (`title`, `content` y `metadata`) |
| `POST` | `/search` | Busca pasajes relevantes en la base de datos de conocimientos por query de texto |
| `DELETE` | `/store` | Limpia por completo la base de conocimientos local en memoria y disco |
| `GET` | `/ping` | Healthcheck del servicio |
| `POST` | `/api/shutdown` | Guarda el store actual y apaga el servicio de RAG |
