import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { prisma } from '../lib/prisma';
import { getCoupleCommunityColor } from '../utils/communityColors';

export const getPrivateMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;

  const messages = await prisma.message.findMany({
    where: {
      chatType: 'private',
      matchId: matchId,
    },
    include: {
      sender: { select: { coupleId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  const finalMessages = messages.map((m: any) => {
    return {
      _id: m.id,
      content: m.content,
      contentType: m.contentType,
      senderName: m.senderName,
      senderUserId: m.senderUserId,
      senderCoupleId: m.sender?.coupleId, 
      senderIndividualName: m.senderName,
      timestamp: m.createdAt,
      readBy: m.readBy || [],
      audioDuration: m.audioDuration,
      senderImage: undefined 
    };
  });

  sendSuccess({ res, data: { matchId, messages: finalMessages } });
};

export const sendPrivateMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;
  const { content, contentType } = req.body;

  const { userId, coupleId, userName } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  
  const message = await prisma.message.create({
    data: {
      chatType: 'private',
      matchId: matchId,
      senderId: coupleId,
      senderUserId: userId,
      senderName: userName || 'User',
      content,
      contentType: (contentType || 'text') as any,
      audioDuration: req.body.audioDuration,
    }
  });

  sendSuccess({ res, data: { message }, statusCode: 201 });
};

export const getGroupMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;

  const messages = await prisma.message.findMany({
    where: {
      chatType: 'group',
      communityId: communityId,
    },
    include: {
      sender: { select: { coupleId: true, profileName: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  const finalMessages = messages.map((m: any) => {
    return {
      _id: m.id,
      content: m.content,
      contentType: m.contentType,
      senderCoupleId: m.sender?.coupleId,
      senderName: m.sender?.profileName || 'Unknown Couple', 
      senderIndividualName: m.senderName, 
      accent: getCoupleCommunityColor(m.sender?.coupleId || ''),
      timestamp: m.createdAt,
      readBy: m.readBy || [],
      audioDuration: m.audioDuration,
    };
  });

  sendSuccess({ res, data: { communityId, messages: finalMessages } });
};

export const sendGroupMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;
  const { content, contentType } = req.body;

  const { userId, coupleId, userName } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  const message = await prisma.message.create({
    data: {
      chatType: 'group',
      communityId: communityId,
      senderId: coupleId,
      senderUserId: userId,
      senderName: userName || 'User',
      content,
      contentType: (contentType || 'text') as any,
      audioDuration: req.body.audioDuration,
    }
  });

  sendSuccess({ res, data: { message }, statusCode: 201 });
};
