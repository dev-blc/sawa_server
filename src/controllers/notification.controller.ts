import { Request, Response } from 'express';
import { Notification } from '../models/Notification.model';
import { sendSuccess } from '../utils/response';
import { Couple } from '../models/Couple.model';
import { AppError } from '../utils/AppError';

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const me = await Couple.findOne({ coupleId });
  if (!me) throw new AppError('Couple profile not found', 404);

  // Query matching either our _id or our coupleId string
  const notifications = await Notification.find({ 
    $or: [{ recipient: me._id }, { recipient: me.coupleId as any }] 
  })
    .populate('sender', 'profileName primaryPhoto')
    .sort({ createdAt: -1 })
    .limit(50);

  console.log(`[NotificationController] User: ${me.coupleId}, Found ${notifications.length} notifications.`);

  sendSuccess({ res, statusCode: 200, data: { notifications } });
};

export const markAsRead = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  await Notification.findByIdAndUpdate(id, { read: true });
  sendSuccess({ res, statusCode: 200, message: 'Notification marked as read' });
};

export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
   const { coupleId } = req.user!;
   const me = await Couple.findOne({ coupleId });
   if (!me) throw new AppError('Couple profile not found', 404);
   
   const count = await Notification.countDocuments({ 
     $or: [{ recipient: me._id }, { recipient: me.coupleId as any }], 
     read: false 
   });
   sendSuccess({ res, statusCode: 200, data: { count } });
};
