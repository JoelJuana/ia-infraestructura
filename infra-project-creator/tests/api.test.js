const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Configurar de antemano la variable de entorno para que el servidor y los servicios usen la sandbox de prueba
const sandboxPath = path.resolve(__dirname, 'tmp_sandbox');
process.env.BASE_PROYECTOS_DIR = sandboxPath;
process.env.NODE_ENV = 'test';

// Cargar la app después de mockear la variable de entorno
const app = require('../server');

describe('Suite de Pruebas - API de Scaffolding y Automatización', () => {
  
  // Configuración del sandbox de prueba antes de correr los tests
  beforeAll(() => {
    // 1. Limpiar previamente si existiera por un fallo anterior
    if (fs.existsSync(sandboxPath)) {
      fs.rmSync(sandboxPath, { recursive: true, force: true });
    }
    // 2. Crear el sandbox físico
    fs.mkdirSync(sandboxPath, { recursive: true });
    
    // 2. Crear las carpetas de plantillas simuladas
    const templatesDir = path.join(sandboxPath, '_plantillas');
    fs.mkdirSync(path.join(templatesDir, 'node', 'src', 'utils'), { recursive: true });
    
    // 3. Crear archivos de plantilla mínimos
    fs.writeFileSync(
      path.join(templatesDir, 'node', 'package.json'),
      JSON.stringify({
        name: '{{nameClean}}',
        version: '1.0.0',
        main: 'src/main.js',
        description: '{{PROJECT_DESCRIPTION}}',
        author: '{{AUTHOR}}'
      }, null, 2),
      'utf8'
    );
    
    fs.writeFileSync(
      path.join(templatesDir, 'node', 'README.md'),
      '# {{PROJECT_NAME}}\n\n{{PROJECT_DESCRIPTION}}\n',
      'utf8'
    );
    
    fs.writeFileSync(
      path.join(templatesDir, 'node', 'src', 'main.js'),
      'console.log("Test {{PROJECT_NAME}}");\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(templatesDir, 'node', 'src', 'utils', 'helper.js'),
      'module.exports = {};\n',
      'utf8'
    );

    // 4. Crear catálogo central de proyectos de prueba vacío
    fs.writeFileSync(
      path.join(sandboxPath, 'projects.json'),
      JSON.stringify([], null, 2),
      'utf8'
    );
  });

  // Limpieza del sandbox después de correr todos los tests
  afterAll(() => {
    if (fs.existsSync(sandboxPath)) {
      fs.rmSync(sandboxPath, { recursive: true, force: true });
    }
  });

  // 1. Validar endpoint de Health check
  describe('GET /ping', () => {
    it('Debería responder status: ok', async () => {
      const res = await request(app).get('/ping');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
    });
  });

  // 2. Validar endpoint de Diagnóstico
  describe('GET /api/diagnose', () => {
    it('Debería responder con el estado de las herramientas del sistema', async () => {
      const res = await request(app).get('/api/diagnose');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('node');
      expect(res.body).toHaveProperty('git');
      expect(res.body).toHaveProperty('python');
    });
  });

  // 3. Validar endpoint para Obtener listado de proyectos
  describe('GET /api/projects', () => {
    it('Debería devolver un catálogo de proyectos vacío inicialmente', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('projects');
      expect(res.body.projects).toBeInstanceOf(Array);
      expect(res.body.projects.length).toBe(0);
      expect(res.body).toHaveProperty('baseDomain');
    });
  });

  // 4. Validar creación, consulta y eliminación de proyectos
  describe('Flujo de Proyecto: Crear, Renombrar y Eliminar', () => {
    const testProjName = 'test-proyecto-api';
    const renamedProjName = 'test-proyecto-renombrado';
    let jobId = null;

    it('POST /api/projects/create - Debería iniciar el Job de creación de proyecto', async () => {
      const payload = {
        name: testProjName,
        type: 'node',
        description: 'Proyecto creado durante los tests unitarios.',
        author: 'Jest-Runner',
        extras: ['gitignore']
      };

      const res = await request(app)
        .post('/api/projects/create')
        .send(payload);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('jobId');
      expect(res.body).toHaveProperty('message');
      
      jobId = res.body.jobId;
    });

    it('GET /api/status - Debería consultar el estado de creación del Job', async () => {
      expect(jobId).not.toBeNull();
      
      const res = await request(app).get(`/api/status?jobId=${jobId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('logs');
      expect(res.body.logs).toBeInstanceOf(Array);
    });

    it('Debería comprobar que la carpeta del proyecto se haya creado en la sandbox', (done) => {
      // Dar un pequeño timeout para la ejecución asíncrona del Scaffolder
      setTimeout(() => {
        const createdPath = path.join(sandboxPath, testProjName);
        expect(fs.existsSync(createdPath)).toBe(true);
        expect(fs.existsSync(path.join(createdPath, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(createdPath, 'README.md'))).toBe(true);
        
        // Verificar reemplazo de placeholders
        const readmeContent = fs.readFileSync(path.join(createdPath, 'README.md'), 'utf8');
        expect(readmeContent).toContain(testProjName);
        
        const pkg = JSON.parse(fs.readFileSync(path.join(createdPath, 'package.json'), 'utf8'));
        expect(pkg.name).toBe(testProjName.toLowerCase());
        expect(pkg.author).toBe('Jest-Runner');
        done();
      }, 1000);
    });

    it('POST /api/projects/rename - Debería renombrar el proyecto en el disco y catálogo', async () => {
      const res = await request(app)
        .post('/api/projects/rename')
        .send({
          oldName: testProjName,
          newName: renamedProjName
        });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      
      // Comprobar renombrado físico
      expect(fs.existsSync(path.join(sandboxPath, testProjName))).toBe(false);
      expect(fs.existsSync(path.join(sandboxPath, renamedProjName))).toBe(true);

      // Comprobar package.json renombrado
      const pkg = JSON.parse(fs.readFileSync(path.join(sandboxPath, renamedProjName, 'package.json'), 'utf8'));
      expect(pkg.name).toBe(renamedProjName.toLowerCase());
    });

    it('DELETE /api/projects/:name - Debería eliminar el proyecto y limpiar sandbox', async () => {
      const res = await request(app)
        .delete(`/api/projects/${renamedProjName}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('success', true);

      // Comprobar eliminación física
      expect(fs.existsSync(path.join(sandboxPath, renamedProjName))).toBe(false);

      // Comprobar remoción del catálogo projects.json
      const projectsJson = JSON.parse(fs.readFileSync(path.join(sandboxPath, 'projects.json'), 'utf8'));
      expect(projectsJson.some(p => p.name === renamedProjName)).toBe(false);
    });

    it('DELETE /api/projects/:name - Debería rechazar borrar carpetas protegidas (ej: crear-proyecto)', async () => {
      const res = await request(app)
        .delete('/api/projects/crear-proyecto');

      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toContain('Operación denegada');
    });
  });
});
