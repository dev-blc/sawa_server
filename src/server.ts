import http from 'http';
import { createApp } from './app';
import { connectDB } from './config/db';
import { createSocketServer } from './sockets/index';
import { env } from './config/env';
import { logger } from './utils/logger';

const start = async (): Promise<void> => {
  // 1. Connect to MongoDB
  await connectDB();

  // 2. Create Express app
  const app = createApp();

  // 3. Create HTTP server
  const httpServer = http.createServer(app);

  // 4. Attach Socket.io
  const io = createSocketServer(httpServer);
  (global as any).io = io;

  // 5. Start listening
  httpServer.listen(env.PORT, () => {
    logger.info(`🚀  SAWA Server running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`📡  Health check: http://localhost:${env.PORT}/health`);
    logger.info(`🌐  API base:     http://localhost:${env.PORT}/api/v1`);
  });

  // ─── Self-Wakeup Logic (Render Keep-Alive) ──────────────────────────────────
  if (env.RENDER_EXTERNAL_URL) {
    const WAKEUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
    setInterval(async () => {
      try {
        const url = `${env.RENDER_EXTERNAL_URL}/wakeup`;
        const res = await fetch(url);
        if (res.ok) {
           logger.info(`⏰  Self-wakeup ping successful: ${url}`);
        } else {
           logger.warn(`⏰  Self-wakeup ping failed with status ${res.status}`);
        }
      } catch (err) {
        logger.error('⏰  Error during self-wakeup ping:', err);
      }
    }, WAKEUP_INTERVAL);
    logger.info(`⏰  Self-wakeup scheduled every 10 mins for: ${env.RENDER_EXTERNAL_URL}`);
  }

  // ─── Graceful Shutdown ──────────────────────────────────────────────────────
  const shutdown = (signal: string): void => {
    logger.info(`\n⚠️   ${signal} received. Shutting down gracefully...`);
    httpServer.close(() => {
      logger.info('✅  HTTP server closed.');
      process.exit(0);
    });

    // Force exit after 10s if server hasn't closed
    setTimeout(() => {
      logger.error('❌  Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    process.exit(1);
  });
};

start();
