import { Server as SocketIOServer, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { getCoupleCommunityColor } from '../utils/communityColors';

export const registerChatHandlers = (io: SocketIOServer, socket: Socket): void => {
  socket.on(SOCKET_EVENTS.CHAT_JOIN, (data: { chatId: string }) => {
    socket.join(`chat:${data.chatId}`);
    logger.info(`✅ Socket ${socket.id} joined chat room: chat:${data.chatId}`);
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

      socket.join(`chat:${data.chatId}`);

      try {
        const user = await prisma.user.findUnique({ where: { id: socket.userId } });
        if (!user) return;

        const couple = await prisma.couple.findUnique({ where: { coupleId: socket.coupleId } });
        if (!couple) return;

        const timestamp = new Date().toISOString();
        const chatType = data.chatType || 'private';

        const broadcastData = {
          _id: crypto.randomUUID(), // Temporarily use UUID for frontend keying
          clientMessageId: data.clientMessageId,
          chatId: data.chatId,
          chatType,
          senderCoupleId: socket.coupleId, 
          senderUserId: socket.userId,   
          senderName: socket.userName || data.senderIndividualName || 'Me', 
          accent: getCoupleCommunityColor(socket.coupleId),
          content: data.content,
          contentType: data.contentType ?? 'text',
          audioDuration: data.audioDuration,
          timestamp,
        };

        io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, broadcastData);

        if (chatType === 'private') {
           const match = await prisma.match.findUnique({ where: { id: data.chatId } });
           if (match) {
              const recipientId = match.couple1Id === couple.id ? match.couple2Id : match.couple1Id;
              const recipientCouple = await prisma.couple.findUnique({ where: { id: recipientId } });
              if (recipientCouple?.coupleId) {
                 io.to(`couple:${recipientCouple.coupleId}`).emit(SOCKET_EVENTS.CHAT_MESSAGE, broadcastData);
              }
           }
        }

        (async () => {
          try {
            const msg = await prisma.message.create({
              data: {
                chatType: chatType as any,
                matchId: chatType === 'private' ? data.chatId : null,
                communityId: chatType === 'group' ? data.chatId : null,
                senderId: couple.id,
                senderUserId: socket.userId!,
                senderName: socket.userName || data.senderIndividualName || 'Unknown',
                content: data.content,
                contentType: (data.contentType || 'text') as any,
                audioDuration: data.audioDuration,
                createdAt: new Date(timestamp),
              }
            });

            if (chatType === 'private') {
                const match = await prisma.match.findUnique({ where: { id: data.chatId } });
                if (match) {
                   const recipientId = match.couple1Id === couple.id ? match.couple2Id : match.couple1Id;
                   const existingUnread = await prisma.notification.findFirst({
                     where: {
                       recipientId: recipientId,
                       type: 'message',
                       read: false,
                       data: { path: ['matchId'], equals: data.chatId } as any
                     }
                   });

                   if (!existingUnread) {
                     await prisma.notification.create({
                       data: {
                         recipientId: recipientId,
                         senderId: couple.id,
                         type: 'message',
                         title: `New Message from ${couple.profileName}`,
                         message: `You have new messages from ${couple.profileName}`,
                         data: { matchId: data.chatId, coupleName: couple.profileName }
                       }
                     });
                   }
                }
            } else if (chatType === 'group') {
                const community = await prisma.community.findUnique({
                    where: { id: data.chatId },
                    include: { members: true }
                });
                if (community) {
                   const others = community.members.filter((m: any) => m.coupleId !== couple.id);
                   for (const member of others) {
                      const existing = await prisma.notification.findFirst({
                         where: {
                            recipientId: member.coupleId,
                            type: 'message',
                            read: false,
                            data: { path: ['communityId'], equals: data.chatId } as any
                         }
                      });

                      if (!existing) {
                         await prisma.notification.create({
                            data: {
                               recipientId: member.coupleId,
                               senderId: couple.id,
                               type: 'message',
                               title: `New in ${community.name}`,
                               message: `${couple.profileName} sent a message`,
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

      // Prisma doesn't have native $addToSet for string arrays in the same way, 
      // but we can use set logic or just leave it for now if readBy is an array.
      // Actually, my schema uses `readBy String[] @default([])`
      
      const messagesToUpdate = await prisma.message.findMany({
          where: {
              OR: [
                  { matchId: data.chatId },
                  { communityId: data.chatId }
              ],
              senderId: { not: couple.id },
              NOT: { readBy: { has: couple.id } }
          }
      });

      for (const msg of messagesToUpdate) {
          await prisma.message.update({
              where: { id: msg.id },
              data: { readBy: { set: [...msg.readBy, couple.id] } }
          });
      }

      io.to(`chat:${data.chatId}`).emit(SOCKET_EVENTS.CHAT_READ, {
        chatId: data.chatId,
        readByCoupleId: socket.coupleId
      });

      await prisma.notification.updateMany({
        where: { recipientId: couple.id, type: 'message' }, // Simplification: mark all messages read
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
