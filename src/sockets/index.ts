import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verifyAccessToken, isAccessTokenDenied } from '../utils/jwt';
import { isAccessTokenRevoked } from '../services/tokenDenylist';
import { prisma } from '../lib/prisma';
import { registerChatHandlers } from './chat.socket';
import { registerMatchHandlers } from './match.socket';
import { registerUsHandlers } from './us.socket';
import { SOCKET_EVENTS } from '../constants/socketEvents';

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
    // Allow voice messages up to 10 MB (base64 audio). Default is 1 MB which
    // silently disconnects the socket when longer recordings are sent.
    maxHttpBufferSize: 10e6,
  });

  // ─── Redis Adapter (Scalability) ──────────────────────────────────────────
  if (env.REDIS_URL) {
    try {
      const pubClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
      });
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => logger.error('Redis PubClient Error:', err));
      subClient.on('error', (err) => logger.error('Redis SubClient Error:', err));

      io.adapter(createAdapter(pubClient, subClient));
      logger.info('✅ Socket.io Redis adapter initialized');
    } catch (err) {
      logger.error('❌ Failed to initialize Redis adapter:', err);
    }
  } else {
      logger.warn('⚠️  REDIS_URL not found. Socket.io running without Redis adapter (Single-instance only).');
  }

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

      // Logout containment (H4): mirror the HTTP `authenticate` middleware — a
      // token revoked at logout (its jti denylisted, or issued before the
      // user's revocation watermark) must not open a WebSocket either.
      const [jtiDenied, issuedBeforeLogout] = await Promise.all([
        isAccessTokenDenied(payload.jti),
        isAccessTokenRevoked(payload.userId, payload.iat),
      ]);
      if (jtiDenied || issuedBeforeLogout) {
        logger.warn(`❌ Socket ${socket.id} rejected: token revoked by logout`);
        return next(new Error('Session ended. Please sign in again.'));
      }

      socket.userId = payload.userId;
      socket.coupleId = payload.coupleId;
      // Mirrored onto socket.data because custom properties do NOT survive
      // fetchSockets(): a RemoteSocket from another PM2 worker exposes only
      // data/rooms/handshake. Cluster-correct presence checks read these.
      socket.data.userId = payload.userId;
      socket.data.coupleId = payload.coupleId;

      // Mirror the HTTP `authenticate` middleware: banned or deleted couples must
      // not be able to open a WebSocket (chat, US-space, games) either.
      if (payload.coupleId) {
        const couple = await prisma.couple.findUnique({
          where: { coupleId: payload.coupleId },
          select: { bannedAt: true },
        });
        if (!couple) {
          logger.warn(`❌ Socket ${socket.id} rejected: account no longer exists`);
          return next(new Error('Account no longer exists'));
        }
        if (couple.bannedAt) {
          logger.warn(`❌ Socket ${socket.id} rejected: account suspended`);
          return next(new Error('Account suspended'));
        }
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { name: true, role: true, coupleId: true },
      });
      if (user) {
        let resolvedName = user.name || '';
        if (!resolvedName && user.coupleId) {
          // Fall back to first name from couple profileName (e.g. "Kiran & Stella")
          const couple = await prisma.couple.findUnique({
            where: { coupleId: user.coupleId },
            select: { profileName: true },
          });
          if (couple?.profileName) {
            const parts = couple.profileName.split(/\s*&\s*/);
            resolvedName = (user.role === 'partner' ? parts[1] : parts[0])?.trim() || '';
          }
        }
        socket.userName = resolvedName || 'Unknown';
        socket.userRole = user.role;
      }
      next();
    } catch (err: any) {
      logger.warn(`❌ Socket ${socket.id} auth failed: ${err.message}`);
      next(new Error('Invalid authentication token'));
    }
  });

  // ─── Partner presence (ambient, socket-only) ────────────────────────────────
  // Live socket count per userId for THIS worker. A user can hold several
  // sockets at once (reconnect overlap, a second device), so presence
  // transitions fire only on the FIRST socket in (offline → online) and the
  // LAST socket out (online → offline). Deliberately no Notification row and no
  // push — presence is ambient and must never buzz a phone.
  //
  // PM2-cluster truth (see ecosystem.config.js): the server runs in cluster
  // mode (4 workers when REDIS_URL is set) and PM2 provides NO sticky sessions —
  // the cluster module distributes each new connection across workers. A single
  // socket lives its whole life on one worker, and the Redis adapter relays
  // these emits to the couple room on every worker, so DELIVERY is
  // cluster-correct. COUNTING is per-worker: exact for the dominant mobile case
  // (one device → one socket), but a user whose sockets land on different
  // workers (second device / reconnect overlap) can flicker a false
  // offline → online. If presence ever needs to be exact across workers, move
  // these counts to Redis (INCR/DECR with a TTL).
  const liveSocketsPerUser = new Map<string, number>();

  io.on('connection', (socket: Socket) => {
    // Per-connection chatter is debug-only so production logs stay readable at scale.
    logger.debug(`✨ Socket Connected: ${socket.id}`);

    registerChatHandlers(io, socket);
    registerMatchHandlers(io, socket);
    registerUsHandlers(io, socket);

    if (socket.coupleId) {
        socket.join(`couple:${socket.coupleId}`);
    }

    // Presence: first socket in → the partner sees them come online. The payload
    // carries userId so each client ignores its own presence events.
    if (socket.userId && socket.coupleId) {
      const count = liveSocketsPerUser.get(socket.userId) ?? 0;
      liveSocketsPerUser.set(socket.userId, count + 1);
      if (count === 0) {
        io.to(`couple:${socket.coupleId}`).emit(SOCKET_EVENTS.US_PARTNER_PRESENCE, {
          userId: socket.userId,
          online: true,
        });
      }
    }

    socket.on('disconnect', (reason) => {
      logger.debug(`Socket disconnected: ${socket.id} — ${reason}`);

      // Presence: last socket out → the partner sees them go offline.
      if (socket.userId && socket.coupleId) {
        const count = liveSocketsPerUser.get(socket.userId) ?? 0;
        if (count <= 1) {
          liveSocketsPerUser.delete(socket.userId);
          io.to(`couple:${socket.coupleId}`).emit(SOCKET_EVENTS.US_PARTNER_PRESENCE, {
            userId: socket.userId,
            online: false,
          });
        } else {
          liveSocketsPerUser.set(socket.userId, count - 1);
        }
      }
    });
  });

  return io;
};
