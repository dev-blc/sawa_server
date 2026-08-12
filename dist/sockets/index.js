"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketServer = void 0;
const socket_io_1 = require("socket.io");
const redis_adapter_1 = require("@socket.io/redis-adapter");
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const jwt_1 = require("../utils/jwt");
const prisma_1 = require("../lib/prisma");
const chat_socket_1 = require("./chat.socket");
const match_socket_1 = require("./match.socket");
const us_socket_1 = require("./us.socket");
const createSocketServer = (httpServer) => {
    const allowedOrigins = env_1.env.CORS_ORIGINS.split(',').map((o) => o.trim());
    const io = new socket_io_1.Server(httpServer, {
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
    if (env_1.env.REDIS_URL) {
        try {
            const pubClient = new ioredis_1.default(env_1.env.REDIS_URL, {
                maxRetriesPerRequest: null,
            });
            const subClient = pubClient.duplicate();
            pubClient.on('error', (err) => logger_1.logger.error('Redis PubClient Error:', err));
            subClient.on('error', (err) => logger_1.logger.error('Redis SubClient Error:', err));
            io.adapter((0, redis_adapter_1.createAdapter)(pubClient, subClient));
            logger_1.logger.info('✅ Socket.io Redis adapter initialized');
        }
        catch (err) {
            logger_1.logger.error('❌ Failed to initialize Redis adapter:', err);
        }
    }
    else {
        logger_1.logger.warn('⚠️  REDIS_URL not found. Socket.io running without Redis adapter (Single-instance only).');
    }
    io.use(async (socket, next) => {
        let token = socket.handshake.auth?.token;
        if (!token)
            token = socket.handshake.query?.token;
        if (!token) {
            logger_1.logger.warn(`❌ Socket ${socket.id} connection rejected: Token missing`);
            return next(new Error('Authentication token missing'));
        }
        if (token.startsWith('Bearer '))
            token = token.slice(7);
        try {
            const payload = (0, jwt_1.verifyAccessToken)(token);
            socket.userId = payload.userId;
            socket.coupleId = payload.coupleId;
            // Mirror the HTTP `authenticate` middleware: banned or deleted couples must
            // not be able to open a WebSocket (chat, US-space, games) either.
            if (payload.coupleId) {
                const couple = await prisma_1.prisma.couple.findUnique({
                    where: { coupleId: payload.coupleId },
                    select: { bannedAt: true },
                });
                if (!couple) {
                    logger_1.logger.warn(`❌ Socket ${socket.id} rejected: account no longer exists`);
                    return next(new Error('Account no longer exists'));
                }
                if (couple.bannedAt) {
                    logger_1.logger.warn(`❌ Socket ${socket.id} rejected: account suspended`);
                    return next(new Error('Account suspended'));
                }
            }
            const user = await prisma_1.prisma.user.findUnique({
                where: { id: payload.userId },
                select: { name: true, role: true, coupleId: true },
            });
            if (user) {
                let resolvedName = user.name || '';
                if (!resolvedName && user.coupleId) {
                    // Fall back to first name from couple profileName (e.g. "Kiran & Stella")
                    const couple = await prisma_1.prisma.couple.findUnique({
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
        }
        catch (err) {
            logger_1.logger.warn(`❌ Socket ${socket.id} auth failed: ${err.message}`);
            next(new Error('Invalid authentication token'));
        }
    });
    io.on('connection', (socket) => {
        // Per-connection chatter is debug-only so production logs stay readable at scale.
        logger_1.logger.debug(`✨ Socket Connected: ${socket.id}`);
        (0, chat_socket_1.registerChatHandlers)(io, socket);
        (0, match_socket_1.registerMatchHandlers)(io, socket);
        (0, us_socket_1.registerUsHandlers)(io, socket);
        if (socket.coupleId) {
            socket.join(`couple:${socket.coupleId}`);
        }
        socket.on('disconnect', (reason) => {
            logger_1.logger.debug(`Socket disconnected: ${socket.id} — ${reason}`);
        });
    });
    return io;
};
exports.createSocketServer = createSocketServer;
//# sourceMappingURL=index.js.map