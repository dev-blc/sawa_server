import mongoose from 'mongoose';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import { logger } from '../utils/logger';
import { Message } from '../models/Message.model';
import { Couple } from '../models/Couple.model';
import { User } from '../models/User.model';
import { Notification } from '../models/Notification.model';
import { Match } from '../models/Match.model';
import { Community } from '../models/Community.model';
import { getCoupleCommunityColor } from '../utils/communityColors';

/**
 * Register private & group chat socket event handlers.
 */
export const registerChatHandlers = (io: SocketIOServer, socket: Socket): void => {
  // Join a chat room (private or group)
  socket.on(SOCKET_EVENTS.CHAT_JOIN, (data: { chatId: string }) => {
    socket.join(`chat:${data.chatId}`);
    logger.info(`✅ Socket ${socket.id} (User: ${socket.userId}) joined chat room: chat:${data.chatId}`);
  });

  // Leave a chat room
  socket.on(SOCKET_EVENTS.CHAT_LEAVE, (data: { chatId: string }) => {
    socket.leave(`chat:${data.chatId}`);
    logger.debug(`Socket ${socket.id} left chat:${data.chatId}`);
  });

  // Receive message from client — broadcast to room
  socket.on(
    SOCKET_EVENTS.CHAT_MESSAGE,
    async (data: { chatId: string; content: string; contentType: string; chatType?: 'private' | 'group'; audioDuration?: number; senderIndividualName?: string }) => {
      
      if (!socket.userId || !socket.coupleId) {
         logger.warn(`Unauthorized message attempt from socket ${socket.id}`);
         return;
      }

      // Ensure joining the room (in case of reconnection)
      socket.join(`chat:${data.chatId}`);

      try {
        // Validate data.chatId is valid ObjectId
        if (!mongoose.Types.ObjectId.isValid(data.chatId)) {
          logger.warn(`Invalid chatId received in CHAT_MESSAGE: ${data.chatId}`);
          return;
        }

        const user = await User.findById(socket.userId);
        if (!user) return;

        const couple = await Couple.findOne({ coupleId: socket.coupleId });
        if (!couple) return;

        const chatType = data.chatType || 'private';

        // Persist message
        const message = await Message.create({
          chatType,
          chatId: data.chatId,
          sender: couple._id,
          senderUser: socket.userId,
          senderName: user.name || socket.userName || 'Unknown',
          content: data.content,
          contentType: data.contentType || 'text',
          audioDuration: data.audioDuration,
        });

        const broadcastData = {
          _id: message._id,
          chatId: data.chatId,
          chatType,
          senderCoupleId: socket.coupleId, 
          senderUserId: socket.userId,   
          senderName: couple.profileName || user.name || socket.userName || 'Me', 
          senderIndividualName: user.name || socket.userName || data.senderIndividualName || 'Me',
          senderRole: socket.userRole,
          accent: getCoupleCommunityColor(socket.coupleId),
          content: data.content,
          contentType: data.contentType ?? 'text',
          audioDuration: data.audioDuration,
          timestamp: message.createdAt.toISOString(),
        };

        // Broadcast to specific room
        io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, broadcastData);

        logger.info(`Message saved and broadcasted to chat:${data.chatId} (${chatType})`);

        // ─── NOTIFICATIONS ───
        if (chatType === 'private') {
           const match = await Match.findById(data.chatId);
           if (match) {
              const recipientId = match.couple1.equals(couple._id) ? match.couple2 : match.couple1;
              
              const existingUnread = await Notification.findOne({
                recipient: recipientId,
                type: 'message',
                'data.matchId': data.chatId,
                read: false
              });

              if (!existingUnread) {
                await Notification.create({
                  recipient: recipientId,
                  sender: couple._id,
                  type: 'message',
                  title: `New Message from ${couple.profileName}`,
                  message: `You have new messages from ${couple.profileName}`,
                  data: { matchId: data.chatId, coupleName: couple.profileName }
                });
              }
           }
        } else if (chatType === 'group') {
           const community = await Community.findById(data.chatId);
           if (community) {
              // Notify all other members
              const others = community.members.filter(m => m.toString() !== couple._id.toString());
              for (const memberId of others) {
                 // Check if unread community notification exists
                 const existing = await Notification.findOne({
                    recipient: memberId,
                    type: 'message',
                    'data.communityId': data.chatId,
                    read: false
                 });

                 if (!existing) {
                    await Notification.create({
                       recipient: memberId,
                       sender: couple._id,
                       type: 'message',
                       title: `New in ${community.name}`,
                       message: `${couple.profileName} sent a message to the group`,
                       data: { communityId: community._id, communityName: community.name, chatOnly: true }
                    });
                 }
              }
           }
        }

      } catch (err) {
        logger.error('Failed to handle CHAT_MESSAGE socket event:', err);
      }
    },
  );

  // Mark message as read / "Seen" feature
  socket.on(SOCKET_EVENTS.CHAT_READ, async (data: { chatId: string }) => {
    if (!socket.userId || !socket.coupleId) return;
    
    // Ensure joining the room
    socket.join(`chat:${data.chatId}`);

    try {
      // Validate data.chatId is valid ObjectId
      if (!mongoose.Types.ObjectId.isValid(data.chatId)) {
        logger.warn(`Invalid chatId received in CHAT_READ: ${data.chatId}`);
        return;
      }

      const couple = await Couple.findOne({ coupleId: socket.coupleId });
      if (!couple) return;

      // Update all unread messages in this chat where we are NOT the sender
      await Message.updateMany(
        { 
          chatId: data.chatId, 
          sender: { $ne: couple._id },
          readBy: { $ne: couple._id }
        },
        { $addToSet: { readBy: couple._id } }
      );

      // Broadcast "Seen" event to the room
      io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_READ, {
        chatId: data.chatId,
        readByCoupleId: socket.coupleId
      });

      // ─── NEW: Clear message notifications when chat is read ───
      await Notification.updateMany(
        { recipient: couple._id, type: 'message', 'data.matchId': data.chatId },
        { $set: { read: true } }
      );

      logger.debug(`Chat ${data.chatId} marked as read by ${socket.coupleId}`);
    } catch (err) {
      logger.error('Failed to handle CHAT_READ socket event:', err);
    }
  });

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
