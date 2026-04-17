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
      senderName?: string;
      senderIndividualName?: string;
      repliedToId?: string;
      repliedToText?: string;
      repliedToName?: string;
      clientMessageId?: string;
    }) => {
      if (!socket.userId || !socket.coupleId) return;

      try {
        const chatId = data.chatId;
        const chatType = data.chatType || 'private';
        const timestamp = new Date().toISOString();
        const clientMessageId = data.clientMessageId || `srv-${Date.now()}`;

        const senderName = data.senderName || socket.userName || 'User';
        const senderIndividualName = data.senderIndividualName || socket.userName || 'User';

        // 1. IMMEDIATE BROADCAST (Ultra-low latency 🚀)
        const broadcastData = {
          _id: clientMessageId, // Real Database ID will be synced via fetchHistory later
          clientMessageId,
          chatId,
          chatType,
          senderCoupleId: socket.coupleId,
          senderUserId: socket.userId,
          senderName,
          senderIndividualName,
          senderRole: socket.userRole, // NEW: for role-based coloring
          accent: getCoupleCommunityColor(socket.coupleId),
          content: data.content,
          contentType: data.contentType ?? 'text',
          audioDuration: data.audioDuration,
          timestamp,
          repliedToId: data.repliedToId,
          repliedToText: data.repliedToText,
          repliedToName: data.repliedToName,
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
            const savedMessage = await prisma.message.create({
              data: {
                chatType: chatType as any,
                matchId: chatType === 'private' ? chatId : null,
                communityId: chatType === 'group' ? chatId : null,
                senderId: socket.coupleId!,
                senderUserId: socket.userId!,
                senderName,
                senderIndividualName,
                content: data.content,
                contentType: (data.contentType || 'text') as any,
                audioDuration: data.audioDuration,
                repliedToId: data.repliedToId,
                repliedToText: data.repliedToText,
                repliedToName: data.repliedToName,
                createdAt: new Date(timestamp),
                // Sender has inherently "read" their own message
                readBy: [socket.coupleId!],
              }
            });

            // Sync the real DB id back to the sender so edit/delete work immediately
            socket.emit('chat:messageId', {
              clientMessageId,
              realMessageId: savedMessage.id,
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
      const coupleId = socket.coupleId;

      // Find unread messages and mark them read using Prisma ORM to avoid
      // silent type-cast failures on the PostgreSQL text[] array operators.
      const unread = await prisma.message.findMany({
        where: {
          OR: [{ matchId: data.chatId }, { communityId: data.chatId }],
          senderId: { not: coupleId },
          NOT: { readBy: { has: coupleId } },
        },
        select: { id: true },
      });

      if (unread.length > 0) {
        await Promise.all(
          unread.map((msg) =>
            prisma.message.update({
              where: { id: msg.id },
              data: { readBy: { push: coupleId } },
            }),
          ),
        );
      }

      io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_READ, {
        chatId: data.chatId,
        readByCoupleId: coupleId
      });

      await prisma.notification.updateMany({
        where: { recipientId: coupleId, type: 'message' },
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
