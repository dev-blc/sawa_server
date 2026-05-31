import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { dedupeNotificationsForList } from '../services/notification.service';

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const me = await prisma.couple.findUnique({ where: { coupleId } });
  if (!me) throw new AppError('Couple profile not found', 404);

  const notifications = await prisma.notification.findMany({ 
    where: { recipientId: me.coupleId },
    include: {
      sender: { select: { id: true, profileName: true, primaryPhoto: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });

  const formatted = dedupeNotificationsForList(
    notifications.map((n: any) => ({
      ...n,
      _id: n.id,
      sender: n.sender ? { ...n.sender, _id: n.sender.id } : null,
    })),
  );

  const matchIds = formatted
    .filter((n) => n.type === 'match')
    .map((n) => (n.data as Record<string, unknown> | null)?.matchId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const acceptedMatchIds = new Set<string>();
  if (matchIds.length > 0) {
    const accepted = await prisma.match.findMany({
      where: { id: { in: matchIds }, status: 'accepted' },
      select: { id: true },
    });
    accepted.forEach((m) => acceptedMatchIds.add(m.id));
  }

  const enriched = formatted.map((n) => {
    if (n.type !== 'match') return n;
    const d = (n.data || {}) as Record<string, unknown>;
    const matchId = d.matchId as string | undefined;
    if (!matchId || !acceptedMatchIds.has(matchId) || d.isPending === false) {
      return n;
    }
    const profileName =
      (d.profileName as string) ||
      (n as { sender?: { profileName?: string } }).sender?.profileName ||
      'a couple';
    return {
      ...n,
      title: "You've Connected!",
      message: `You connected with ${profileName}!`,
      data: { ...d, isPending: false },
    };
  });

  sendSuccess({ res, statusCode: 200, data: { notifications: enriched } });
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
     where: { recipientId: me.coupleId, read: false }
   });
   sendSuccess({ res, statusCode: 200, data: { count } });
};
