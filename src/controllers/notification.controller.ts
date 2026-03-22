import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const me = await prisma.couple.findUnique({ where: { coupleId } });
  if (!me) throw new AppError('Couple profile not found', 404);

  const notifications = await prisma.notification.findMany({ 
    where: { recipientId: me.id },
    include: {
      sender: { select: { profileName: true, primaryPhoto: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  logger.info(`[NotificationController] User: ${me.coupleId}, Found ${notifications.length} notifications.`);

  sendSuccess({ res, statusCode: 200, data: { notifications } });
};

export const markAsRead = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  await prisma.notification.update({
    where: { id },
    data: { read: true }
  });
  sendSuccess({ res, statusCode: 200, message: 'Notification marked as read' });
};

export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
   const { coupleId } = req.user!;
   const me = await prisma.couple.findUnique({ where: { coupleId } });
   if (!me) throw new AppError('Couple profile not found', 404);
   
   const count = await prisma.notification.count({ 
     where: { recipientId: me.id, read: false }
   });
   sendSuccess({ res, statusCode: 200, data: { count } });
};
