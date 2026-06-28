module.exports = {
  apps: [
    {
      name: 'sawa-server',
      script: 'dist/server.js',

      // Cluster mode — one worker per CPU core.
      exec_mode: 'cluster',
      instances: 'max',

      // Restart a worker if it exceeds this RSS limit (keeps Railway container healthy).
      max_memory_restart: '400M',

      // Give each worker up to 30 s to bind its port before PM2 marks it failed.
      listen_timeout: 30000,

      // Grace period for in-flight requests on shutdown.
      kill_timeout: 5000,

      // Exponential back-off on crashes (avoids rapid crash-loops).
      exp_backoff_restart_delay: 200,
      max_restarts: 10,

      // Environment is inherited from Railway; set NODE_ENV as fallback only.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
# force rebuild Mon Jun 29 00:16:43 IST 2026
