import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { dedupeNotificationsForList } from '../services/notification.service';
import {
  getCachedNotifUnreadCount,
  setCachedNotifUnreadCount,
  invalidateNotifUnreadCount,
} from '../lib/cache';

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  // coupleId comes from the verified JWT — no extra couple lookup needed.

  const notifications = await prisma.notification.findMany({ 
    where: { recipientId: coupleId },
    include: {
      sender: { select: { id: true, profileName: true, primaryPhoto: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: 200  // show up to 200 most-recent rows (server dedup collapses duplicates further)
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
  const { coupleId } = req.user!;
  const { id } = req.params;
  await prisma.notification.update({
    where: { id },
    data: { read: true }
  });
  // Bust cached unread count for this user.
  if (coupleId) await invalidateNotifUnreadCount(coupleId);
  sendSuccess({ res, statusCode: 200, message: 'Notification marked as read' });
};

export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  // Short-lived cache (10 s) so repeated badge-refresh calls don't hit Postgres.
  // Invalidated every time a new notification is created/marked read.
  const cached = await getCachedNotifUnreadCount(coupleId);
  if (cached !== null) {
    sendSuccess({ res, statusCode: 200, data: { count: cached } });
    return;
  }

  const count = await prisma.notification.count({ 
    where: { recipientId: coupleId, read: false }
  });
  await setCachedNotifUnreadCount(coupleId, count);
  sendSuccess({ res, statusCode: 200, data: { count } });
};
