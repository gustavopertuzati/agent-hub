module.exports = {
  apps: [
    {
      name: 'orkestr-gateway',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      }
    }
  ]
};
