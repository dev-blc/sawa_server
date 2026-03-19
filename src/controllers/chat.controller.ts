import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { Message } from '../models/Message.model';
import { Couple } from '../models/Couple.model';
import { User } from '../models/User.model';
import mongoose from 'mongoose';

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
    .limit(100);

  const finalMessages = populatedMessages.map((m: any) => {
    return {
      _id: m._id,
      content: m.content,
      contentType: m.contentType,
      senderName: m.senderName,
      senderUserId: m.senderUser?._id,
      senderRole: m.senderUser?.role,
      senderCoupleId: m.sender?.coupleId, // The shared string ID (X-Y)
      timestamp: m.createdAt,
      readBy: m.readBy || [],
      // For images, we would ideally store the avatar in user model or fetch it
      // For now, let's assume we use a placeholder or the couple's photo if needed
      // Actually, let's just return a placeholder for individual sender for now
      senderImage: undefined 
    };
  });

  sendSuccess({ res, data: { matchId, messages: finalMessages } });
};

export const sendPrivateMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { matchId } = req.params;
  const { content, contentType } = req.body;

  const user = await User.findById(req.user.userId);
  if (!user) throw new AppError('User not found', 404);

  const couple = await Couple.findOne({ coupleId: user.coupleId });
  if (!couple) throw new AppError('Couple not found', 404);

  const message = await Message.create({
    chatType: 'private',
    chatId: matchId,
    sender: couple._id,
    senderUser: user._id,
    senderName: user.name || 'Unknown',
    content,
    contentType: contentType || 'text',
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
    .populate('sender', 'coupleId')
    .populate('senderUser', 'role')
    .sort({ createdAt: 1 })
    .limit(100);

  const finalMessages = messages.map((m: any) => {
    return {
      _id: m._id,
      content: m.content,
      contentType: m.contentType,
      senderName: m.senderName,
      senderUserId: m.senderUser?._id,
      senderRole: m.senderUser?.role,
      senderCoupleId: m.sender?.coupleId,
      timestamp: m.createdAt,
      readBy: m.readBy || [],
    };
  });

  sendSuccess({ res, data: { communityId, messages: finalMessages } });
};

export const sendGroupMessage = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError('Unauthorized', 401);
  const { communityId } = req.params;
  const { content, contentType } = req.body;

  const user = await User.findById(req.user.userId);
  if (!user) throw new AppError('User not found', 404);

  const couple = await Couple.findOne({ coupleId: user.coupleId });
  if (!couple) throw new AppError('Couple not found', 404);

  const message = await Message.create({
    chatType: 'group',
    chatId: communityId,
    sender: couple._id,
    senderUser: user._id,
    senderName: user.name || 'Unknown',
    content,
    contentType: contentType || 'text',
  });

  sendSuccess({ res, data: { message }, statusCode: 201 });
};
