import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/jwt';
import { User } from '../models/User.model';
import { registerChatHandlers } from './chat.socket';
import { registerMatchHandlers } from './match.socket';

declare module 'socket.io' {
  interface Socket {
    userId?: string;
    coupleId?: string;
    userName?: string;
    userRole?: string;
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
    let token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      token = socket.handshake.query?.token as string | undefined;
    }

    if (!token) {
      logger.warn(`❌ Socket ${socket.id} connection rejected: Token missing`);
      return next(new Error('Authentication token missing'));
    }

    // Handle "Bearer " prefix if present
    if (token.startsWith('Bearer ')) {
      token = token.slice(7);
    }

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.userId;
      socket.coupleId = payload.coupleId;

      // Fetch user name and role for display
      User.findById(payload.userId).then((user) => {
        if (user) {
          socket.userName = user.name || 'Unknown';
          socket.userRole = user.role;
        }
        next();
      }).catch(() => {
        next();
      });

    } catch (err: any) {
      logger.warn(`❌ Socket ${socket.id} auth failed: ${err.message}`);
      next(new Error('Invalid authentication token'));
    }
  });


  // ─── Connection ─────────────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    logger.info(`✨ Socket Connected: ${socket.id}`);
    logger.info(`👤 User: ${socket.userName} (${socket.userId})`);
    logger.info(`💑 Couple ID: ${socket.coupleId}`);
    logger.info(`🛡️  Role: ${socket.userRole}`);

    registerChatHandlers(io, socket);
    registerMatchHandlers(io, socket);

    // Dynamic Room Joining for real-time notifications
    if (socket.coupleId) {
        socket.join(`couple:${socket.coupleId}`);
        logger.info(`✅ Socket joined couple room: couple:${socket.coupleId}`);
    }

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} — ${reason}`);
    });
  });

  return io;
};
