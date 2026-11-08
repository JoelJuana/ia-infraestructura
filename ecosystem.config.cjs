module.exports = {
  apps: [
    {
      name: 'infra-gateway',
      script: 'server.js',
      cwd: 'infra-gateway',
      env: { PORT: 3000 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/infra-gateway.log',
      error_file: '../.infra-logs/infra-gateway.log'
    },
    {
      name: 'infra-github',
      script: 'server.js',
      cwd: 'infra-github',
      env: { PORT: 3100 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/infra-github.log',
      error_file: '../.infra-logs/infra-github.log'
    },
    {
      name: 'infra-firebase',
      script: 'server.js',
      cwd: 'infra-firebase',
      env: { PORT: 3200 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/infra-firebase.log',
      error_file: '../.infra-logs/infra-firebase.log'
    },
    {
      name: 'infra-project-creator',
      script: 'server.js',
      cwd: 'infra-project-creator',
      env: { PORT: 3300 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/infra-project-creator.log',
      error_file: '../.infra-logs/infra-project-creator.log'
    },
    {
      name: 'infra-domain-manager',
      script: 'server.js',
      cwd: 'infra-domain-manager',
      env: { PORT: 3400 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/infra-domain-manager.log',
      error_file: '../.infra-logs/infra-domain-manager.log'
    },
    {
      name: 'api-design-assets',
      script: 'server.js',
      cwd: 'api-design-assets',
      env: { PORT: 3500 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/api-design-assets.log',
      error_file: '../.infra-logs/api-design-assets.log'
    },
    {
      name: 'api-conocimiento-rag',
      script: 'server.js',
      cwd: 'api-conocimiento-rag',
      env: { PORT: 3600 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/api-conocimiento-rag.log',
      error_file: '../.infra-logs/api-conocimiento-rag.log'
    },
    {
      name: 'api-utilidades-scraping',
      script: 'server.js',
      cwd: 'api-utilidades-scraping',
      env: { PORT: 3700 },
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/api-utilidades-scraping.log',
      error_file: '../.infra-logs/api-utilidades-scraping.log'
    }
  ]
};
