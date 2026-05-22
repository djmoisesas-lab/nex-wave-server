module.exports = {
  apps: [{
    name: 'dj-catalog',
    script: './src/index.ts',
    interpreter: 'bun',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    env_file: '.env',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
  }]
};
