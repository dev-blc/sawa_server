import { Server as SocketIOServer, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { getCoupleCommunityColor } from '../utils/communityColors';

export const registerChatHandlers = (io: SocketIOServer, socket: Socket): void => {
  socket.on(SOCKET_EVENTS.CHAT_JOIN, (data: { chatId: string }) => {
    socket.join(`chat:${data.chatId}`);
    logger.info(`📡 [Socket] User ${socket.coupleId} joined chat room: chat:${data.chatId} (Socket: ${socket.id})`);
  });

  socket.on(SOCKET_EVENTS.CHAT_LEAVE, (data: { chatId: string }) => {
    socket.leave(`chat:${data.chatId}`);
  });

  socket.on(
    SOCKET_EVENTS.CHAT_MESSAGE,
    async (data: { 
      chatId: string; 
      content: string; 
      contentType: string; 
      chatType?: 'private' | 'group'; 
      audioDuration?: number; 
      senderIndividualName?: string;
      clientMessageId?: string;
    }) => {
      if (!socket.userId || !socket.coupleId) return;

      try {
        const chatId = data.chatId;
        const chatType = data.chatType || 'private';
        const timestamp = new Date().toISOString();
        const clientMessageId = data.clientMessageId || `srv-${Date.now()}`;

        // 1. IMMEDIATE BROADCAST (Ultra-low latency 🚀)
        const broadcastData = {
          _id: clientMessageId, // Real Database ID will be synced via fetchHistory later
          clientMessageId,
          chatId,
          chatType,
          senderCoupleId: socket.coupleId,
          senderUserId: socket.userId,
          senderName: socket.userName || data.senderIndividualName || 'User',
          accent: getCoupleCommunityColor(socket.coupleId),
          content: data.content,
          contentType: data.contentType ?? 'text',
          audioDuration: data.audioDuration,
          timestamp,
        };

        // Broadcast to room immediately
        logger.info(`📤 [Socket] Broadcasting message from ${socket.coupleId} to chat:${chatId}`);
        io.to(`chat:${chatId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, broadcastData);

        // Private recipient room broadcast
        if (chatType === 'private') {
          (async () => {
            try {
              const match = await prisma.match.findUnique({ 
                where: { id: chatId },
                select: { couple1Id: true, couple2Id: true }
              });
              if (match) {
                const recipientId = match.couple1Id === socket.coupleId ? match.couple2Id : match.couple1Id;
                logger.info(`📤 [Socket] Secondary broadcast to couple:${recipientId}`);
                io.to(`couple:${recipientId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, broadcastData);
              }
            } catch (e) {
              logger.warn('[Socket] Private recipient broadcast failed', e);
            }
          })();
        }

        // 2. BACKGROUND PERSISTENCE & NOTIFICATIONS
        (async () => {
          try {
            // Save to Database
            await prisma.message.create({
              data: {
                chatType: chatType as any,
                matchId: chatType === 'private' ? chatId : null,
                communityId: chatType === 'group' ? chatId : null,
                senderId: socket.coupleId!,
                senderUserId: socket.userId!,
                senderName: socket.userName || data.senderIndividualName || 'Unknown',
                content: data.content,
                contentType: (data.contentType || 'text') as any,
                audioDuration: data.audioDuration,
                createdAt: new Date(timestamp),
              }
            });

            // Notifications
            if (chatType === 'private') {
              const match = await prisma.match.findUnique({ 
                where: { id: chatId },
                include: { couple1: true, couple2: true }
              });
              if (match) {
                 const recipientId = match.couple1Id === socket.coupleId ? match.couple2Id : match.couple1Id;
                 const me = match.couple1Id === socket.coupleId ? match.couple1 : match.couple2;
                 
                 const existingUnread = await prisma.notification.findFirst({
                   where: {
                     recipientId: recipientId,
                     type: 'message',
                     read: false,
                     data: { path: ['matchId'], equals: chatId } as any
                   }
                 });

                 if (!existingUnread) {
                   await prisma.notification.create({
                     data: {
                       recipientId: recipientId,
                       senderId: socket.coupleId,
                       type: 'message',
                       title: `New Message from ${me?.profileName || 'Couple'}`,
                       message: `You have new messages from ${me?.profileName || 'Couple'}`,
                       data: { matchId: chatId, coupleName: me?.profileName }
                     }
                   });
                 }
              }
            } else if (chatType === 'group') {
              const community = await prisma.community.findUnique({
                  where: { id: chatId },
                  include: { members: true }
              });
              if (community) {
                 const others = community.members.filter((m: any) => m.coupleId !== socket.coupleId);
                 for (const member of others) {
                    const existing = await prisma.notification.findFirst({
                       where: {
                          recipientId: member.coupleId,
                          type: 'message',
                          read: false,
                          data: { path: ['communityId'], equals: chatId } as any
                       }
                    });

                    if (!existing) {
                       await prisma.notification.create({
                          data: {
                             recipientId: member.coupleId,
                             senderId: socket.coupleId,
                             type: 'message',
                             title: `New in ${community.name}`,
                             message: `New message in the group`,
                             data: { communityId: community.id, communityName: community.name, chatOnly: true }
                          }
                       });
                    }
                 }
              }
            }
          } catch (bgErr) {
            logger.error(`[Socket] Background work failed:`, bgErr);
          }
        })();
      } catch (err) {
        logger.error('Failed to handle CHAT_MESSAGE socket event:', err);
      }
    },
  );

  socket.on(SOCKET_EVENTS.CHAT_READ, async (data: { chatId: string }) => {
    if (!socket.userId || !socket.coupleId) return;
    
    try {
      const couple = await prisma.couple.findUnique({ where: { coupleId: socket.coupleId } });
      if (!couple) return;

      const messagesToUpdate = await prisma.message.findMany({
          where: {
              OR: [
                  { matchId: data.chatId },
                  { communityId: data.chatId }
              ],
              senderId: { not: couple.coupleId },
              NOT: { readBy: { has: couple.coupleId } }
          }
      });

      for (const msg of messagesToUpdate) {
          await prisma.message.update({
              where: { id: msg.id },
              data: { readBy: { set: [...msg.readBy, couple.coupleId] } }
          });
      }

      io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_READ, {
        chatId: data.chatId,
        readByCoupleId: socket.coupleId
      });

      await prisma.notification.updateMany({
        where: { recipientId: couple.coupleId, type: 'message' },
        data: { read: true }
      });

    } catch (err) {
      logger.error('Failed to handle CHAT_READ socket event:', err);
    }
  });

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
