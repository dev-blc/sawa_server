"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const app_1 = require("./app");
const db_1 = require("./config/db");
const ensureSchema_1 = require("./config/ensureSchema");
const bootstrapAdmin_1 = require("./config/bootstrapAdmin");
const index_1 = require("./sockets/index");
const cycleNotifier_1 = require("./jobs/cycleNotifier");
const migrateUsToPg_1 = require("./jobs/migrateUsToPg");
const env_1 = require("./config/env");
const logger_1 = require("./utils/logger");
const start = async () => {
    // 1. Connect to the database
    await (0, db_1.connectDB)();
    // 1b. Ensure an admin account exists so the dashboard login works after
    //     every deploy. Only the primary worker runs it (idempotent regardless).
    if (!process.env.pm_id || process.env.pm_id === '0') {
        await (0, ensureSchema_1.ensureSchema)();
        await (0, bootstrapAdmin_1.bootstrapAdmin)();
    }
    // 2. Create Express app
    const app = (0, app_1.createApp)();
    // 3. Create HTTP server
    const httpServer = http_1.default.createServer(app);
    // 4. Attach Socket.io
    const io = (0, index_1.createSocketServer)(httpServer);
    global.io = io;
    // 4b. Cycle nudges for the primary partner — one worker only.
    if (!process.env.pm_id || process.env.pm_id === '0') {
        (0, cycleNotifier_1.startCycleNotifier)();
        // One-time backfill of Us-space data from Redis into Postgres.
        (0, migrateUsToPg_1.migrateUsRedisToPostgres)().catch(() => null);
    }
    // 5. Start listening
    httpServer.listen(env_1.env.PORT, () => {
        logger_1.logger.info(`🚀  SAWA Server running on port ${env_1.env.PORT} [${env_1.env.NODE_ENV}]`);
        logger_1.logger.info(`📡  Health check: http://localhost:${env_1.env.PORT}/health`);
        logger_1.logger.info(`🌐  API base:     http://localhost:${env_1.env.PORT}/api/v1`);
    });
    // ─── Self-Wakeup Logic (Keep-Alive on Free / Hobby Tiers) ──────────────────
    // Priority: APP_URL > RENDER_EXTERNAL_URL > RAILWAY_PUBLIC_DOMAIN (auto-set by Railway)
    const rawWakeupUrl = env_1.env.APP_URL ||
        env_1.env.RENDER_EXTERNAL_URL ||
        (env_1.env.RAILWAY_PUBLIC_DOMAIN ? `https://${env_1.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
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
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                    logger_1.logger.info(`⏰ Self-wakeup ping OK: ${url}`);
                }
                else {
                    logger_1.logger.warn(`⏰ Self-wakeup ping failed (${res.status}): ${url}`);
                }
            }
            catch (err) {
                logger_1.logger.error('⏰ Self-wakeup ping error:', err);
            }
        }, WAKEUP_INTERVAL);
        logger_1.logger.info(`⏰ Self-wakeup scheduled every 10 mins → ${wakeupBase}/wakeup`);
    }
    else {
        logger_1.logger.warn('⚠️  No APP_URL / RAILWAY_PUBLIC_DOMAIN set — self-wakeup disabled. Server may sleep on free tiers.');
    }
    // ─── Graceful Shutdown ──────────────────────────────────────────────────────
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown)
            return; // ignore duplicate signals
        shuttingDown = true;
        logger_1.logger.info(`\n⚠️   ${signal} received. Shutting down gracefully...`);
        // Force exit if the graceful drain hasn't finished in time.
        const forceTimer = setTimeout(() => {
            logger_1.logger.error('❌  Forced shutdown after timeout.');
            process.exit(1);
        }, 10000);
        forceTimer.unref();
        // 1. Stop accepting new HTTP connections. 2. Close Socket.IO (disconnects
        // clients cleanly). 3. Release the Prisma connection pool. Each step is
        // best-effort so one failing step never blocks the others.
        httpServer.close(async () => {
            logger_1.logger.info('✅  HTTP server closed.');
            try {
                await new Promise((resolve) => io.close(() => resolve()));
                logger_1.logger.info('✅  Socket.io closed.');
            }
            catch (err) {
                logger_1.logger.error('⚠️  Error closing Socket.io:', err);
            }
            try {
                const { prisma } = await Promise.resolve().then(() => __importStar(require('./lib/prisma')));
                await prisma.$disconnect();
                logger_1.logger.info('✅  Prisma disconnected.');
            }
            catch (err) {
                logger_1.logger.error('⚠️  Error disconnecting Prisma:', err);
            }
            clearTimeout(forceTimer);
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger_1.logger.error('Unhandled promise rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
        logger_1.logger.error('Uncaught exception:', err);
        process.exit(1);
    });
};
start();
//# sourceMappingURL=server.js.map