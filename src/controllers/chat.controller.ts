import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { Message } from '../models/Message.model';
import { Couple } from '../models/Couple.model';
import { User } from '../models/User.model';
import mongoose from 'mongoose';
import { getCoupleCommunityColor } from '../utils/communityColors';

export const getPrivateMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(matchId)) {
     throw new AppError('Invalid match ID', 400);
  }

  const populatedMessages = await Message.find({
    chatType: 'private',
    chatId: new mongoose.Types.ObjectId(matchId),
  })
    .populate('sender', 'coupleId')
    .populate('senderUser', 'role phone')
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  const finalMessages = populatedMessages.map((m: any) => {
    return {
      _id: m._id,
      content: m.content,
      contentType: m.contentType,
      senderName: m.senderName,
      senderUserId: m.senderUser?._id,
      senderRole: m.senderUser?.role,
      senderCoupleId: m.sender?.coupleId, // The shared string ID (X-Y)
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

  const { userId, coupleMongoId, userName } = req.user!;
  
  // ZERO HOPS! No User.findById or Couple.findOne needed anymore.
  const message = await Message.create({
    chatType: 'private',
    chatId: matchId,
    sender: coupleMongoId,
    senderUser: userId,
    senderName: userName || 'User',
    content,
    contentType: contentType || 'text',
    audioDuration: req.body.audioDuration,
  });

  sendSuccess({ res, data: { message }, statusCode: 201 });
};

export const getGroupMessages = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(communityId)) {
    throw new AppError('Invalid community ID', 400);
  }

  const messages = await Message.find({
    chatType: 'group',
    chatId: new mongoose.Types.ObjectId(communityId),
  })
    .populate('sender', 'coupleId profileName')
    .populate('senderUser', 'role')
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  const finalMessages = messages.map((m: any) => {
    return {
      _id: m._id,
      content: m.content,
      contentType: m.contentType,
      senderCoupleId: m.sender?.coupleId,
      senderName: m.sender?.profileName || 'Unknown Couple', // Use couple's profileName
      senderIndividualName: m.senderName, // individual name (Kiran/Raji)
      accent: getCoupleCommunityColor(m.sender?.coupleId),
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

  const { userId, coupleMongoId, userName } = req.user!;

  const message = await Message.create({
    chatType: 'group',
    chatId: communityId,
    sender: coupleMongoId,
    senderUser: userId,
    senderName: userName || 'User',
    content,
    contentType: contentType || 'text',
    audioDuration: req.body.audioDuration,
  });

  sendSuccess({ res, data: { message }, statusCode: 201 });
};
