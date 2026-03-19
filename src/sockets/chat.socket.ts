import { Server as SocketIOServer, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import { logger } from '../utils/logger';
import { Message } from '../models/Message.model';
import { Couple } from '../models/Couple.model';
import { User } from '../models/User.model';

/**
 * Register private & group chat socket event handlers.
 */
export const registerChatHandlers = (io: SocketIOServer, socket: Socket): void => {
  // Join a chat room (private or group)
  socket.on(SOCKET_EVENTS.CHAT_JOIN, (data: { chatId: string }) => {
    socket.join(`chat:${data.chatId}`);
    logger.debug(`Socket ${socket.id} joined chat:${data.chatId}`);
  });

  // Leave a chat room
  socket.on(SOCKET_EVENTS.CHAT_LEAVE, (data: { chatId: string }) => {
    socket.leave(`chat:${data.chatId}`);
    logger.debug(`Socket ${socket.id} left chat:${data.chatId}`);
  });

  // Receive message from client — broadcast to room
  socket.on(
    SOCKET_EVENTS.CHAT_MESSAGE,
    async (data: { chatId: string; content: string; contentType: string; chatType?: 'private' | 'group' }) => {
      
      if (!socket.userId || !socket.coupleId) {
         logger.warn(`Unauthorized message attempt from socket ${socket.id}`);
         return;
      }

      try {
        const user = await User.findById(socket.userId);
        if (!user) return;

        const couple = await Couple.findOne({ coupleId: socket.coupleId });
        if (!couple) return;

        // Persist message
        const message = await Message.create({
          chatType: data.chatType || 'private',
          chatId: data.chatId,
          sender: couple._id,
          senderUser: user._id,
          senderName: user.name || 'Unknown',
          content: data.content,
          contentType: data.contentType || 'text',
        });

        // Broadcast to room
        io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, {
          _id: message._id,
          chatId: data.chatId,
          senderCoupleId: socket.coupleId, // Used for local UI side determination (left/right)
          senderUserId: socket.userId,   // Used for showing who in the couple sent it
          senderName: message.senderName, // Name to display (X, Y, A, B)
          senderRole: user.role,         // Used for color determination (blue/pink vs warm/cool)
          content: data.content,
          contentType: data.contentType ?? 'text',
          timestamp: message.createdAt.toISOString(),
        });

        logger.info(`Message saved and broadcasted to chat:${data.chatId}`);
      } catch (err) {
        logger.error('Failed to handle CHAT_MESSAGE socket event:', err);
      }
    },
  );

  // Typing indicators
  socket.on(SOCKET_EVENTS.CHAT_TYPING, (data: { chatId: string }) => {
    socket.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_TYPING, {
      chatId: data.chatId,
      senderCoupleId: socket.coupleId,
      senderName: socket.userName,
    });
  });

  socket.on(SOCKET_EVENTS.CHAT_STOP_TYPING, (data: { chatId: string }) => {
    socket.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_STOP_TYPING, {
      chatId: data.chatId,
      senderCoupleId: socket.coupleId,
    });
  });
};
