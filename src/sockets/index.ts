import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../lib/prisma';
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
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
  });

  io.use(async (socket: Socket, next) => {
    let token = socket.handshake.auth?.token as string | undefined;
    if (!token) token = socket.handshake.query?.token as string | undefined;

    if (!token) {
      logger.warn(`❌ Socket ${socket.id} connection rejected: Token missing`);
      return next(new Error('Authentication token missing'));
    }

    if (token.startsWith('Bearer ')) token = token.slice(7);

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.userId;
      socket.coupleId = payload.coupleId;

      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (user) {
        socket.userName = user.name || 'Unknown';
        socket.userRole = user.role;
      }
      next();
    } catch (err: any) {
      logger.warn(`❌ Socket ${socket.id} auth failed: ${err.message}`);
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    logger.info(`✨ Socket Connected: ${socket.id}`);
    
    registerChatHandlers(io, socket);
    registerMatchHandlers(io, socket);

    if (socket.coupleId) {
        socket.join(`couple:${socket.coupleId}`);
    }

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} — ${reason}`);
    });
  });

  return io;
};
