import http from 'http';
import { createApp } from './app';
import { connectDB } from './config/db';
import { bootstrapAdmin } from './config/bootstrapAdmin';
import { createSocketServer } from './sockets/index';
import { env } from './config/env';
import { logger } from './utils/logger';

const start = async (): Promise<void> => {
  // 1. Connect to the database
  await connectDB();

  // 1b. Ensure an admin account exists so the dashboard login works after
  //     every deploy. Only the primary worker runs it (idempotent regardless).
  if (!process.env.pm_id || process.env.pm_id === '0') {
    await bootstrapAdmin();
  }

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

  // ─── Self-Wakeup Logic (Keep-Alive on Free / Hobby Tiers) ──────────────────
  // Priority: APP_URL > RENDER_EXTERNAL_URL > RAILWAY_PUBLIC_DOMAIN (auto-set by Railway)
  const rawWakeupUrl =
    env.APP_URL ||
    env.RENDER_EXTERNAL_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

  // In PM2 cluster mode every worker runs this file. Only let worker 0 (or a
  // non-clustered process) run the wakeup ping so we don't fire N simultaneous
  // pings for N workers.
  const isPrimaryWorker = !process.env.pm_id || process.env.pm_id === '0';

  if (rawWakeupUrl && isPrimaryWorker) {
    const wakeupBase = rawWakeupUrl.replace(/\/$/, ''); // strip trailing slash
    // Ping every 10 minutes — well within the 15-minute sleep window on free tiers
    const WAKEUP_INTERVAL = 10 * 60 * 1000;
    setInterval(async () => {
      try {
        const url = `${wakeupBase}/wakeup`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          logger.info(`⏰ Self-wakeup ping OK: ${url}`);
        } else {
          logger.warn(`⏰ Self-wakeup ping failed (${res.status}): ${url}`);
        }
      } catch (err) {
        logger.error('⏰ Self-wakeup ping error:', err);
      }
    }, WAKEUP_INTERVAL);
    logger.info(`⏰ Self-wakeup scheduled every 10 mins → ${wakeupBase}/wakeup`);
  } else {
    logger.warn('⚠️  No APP_URL / RAILWAY_PUBLIC_DOMAIN set — self-wakeup disabled. Server may sleep on free tiers.');
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
