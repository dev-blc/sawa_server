import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import apiRouter from './routes/index';

export const createApp = (): Application => {
  const app = express();

  // ─── Security ───────────────────────────────────────────────────────────────
  app.use(helmet());

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS policy: origin ${origin} not allowed`));
        }
      },
      credentials: true,
    }),
  );

  // ─── Body Parsing ────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ─── Compression ────────────────────────────────────────────────────────────
  app.use(compression());

  // ─── Logging ─────────────────────────────────────────────────────────────────
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
  }

  // ─── Health Check ────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      status: 'healthy',
      service: 'sawa-server',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Wakeup Ping ─────────────────────────────────────────────────────────────
  app.get('/wakeup', (_req: Request, res: Response) => {
    res.status(200).json({ 
      success: true, 
      message: 'Server is awake',
      timestamp: new Date().toISOString()
    });
  });

  // ─── API Routes ──────────────────────────────────────────────────────────────
  app.use('/api/v1', apiRouter);

  // ─── 404 Catch-all ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Route not found',
      code: 404,
    });
  });

  // ─── Global Error Handler ────────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
};
