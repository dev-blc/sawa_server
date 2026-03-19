import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/jwt';
import { registerChatHandlers } from './chat.socket';
import { registerMatchHandlers } from './match.socket';

declare module 'socket.io' {
  interface Socket {
    userId?: string;
    coupleId?: string;
    userName?: string;
  }
}

export const createSocketServer = (httpServer: HTTPServer): SocketIOServer => {
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
    },
  });

  // ─── JWT Auth Middleware ─────────────────────────────────────────────────────
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.userId;
      socket.coupleId = payload.coupleId;

      // Fetch user name for display
      import('../models/User.model').then(({ User }) => {
        User.findById(payload.userId).then((user) => {
           if (user) socket.userName = user.name || 'Unknown';
           next();
        }).catch(() => next());
      }).catch(() => next());

    } catch {
      next(new Error('Invalid authentication token'));
    }
  });


  // ─── Connection ─────────────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    logger.info(`Socket connected: ${socket.id} (user: ${socket.userId})`);

    registerChatHandlers(io, socket);
    registerMatchHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} — ${reason}`);
    });
  });

  return io;
};
