module.exports = {
  apps: [
    {
      name: 'infra-gateway',
      script: 'server.js',
      cwd: 'infra-gateway',
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
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '../.infra-logs/api-utilidades-scraping.log',
      error_file: '../.infra-logs/api-utilidades-scraping.log'
    }
  ]
};
