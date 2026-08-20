import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import {
  dedupeNotificationsForList,
  clearNotification,
  clearAllNotifications,
} from '../services/notification.service';
import { validate } from '../middleware/validate';
import {
  getCachedNotifUnreadCount,
  setCachedNotifUnreadCount,
  invalidateNotifUnreadCount,
} from '../lib/cache';

// Notification ids are cuid() for new rows with legacy Mongo ObjectId strings
// still alive in the table — validate shape, not a specific id format.
const notificationIdParams = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
});
export const validateNotificationIdParams = validate(notificationIdParams, 'params');

/**
 * Rows a user should never be shown or badged for: their OWN Us-space sends.
 * Every notification row is couple-scoped (recipientId = coupleId), so the
 * sender's identity lives only in data.senderUserId. Without this filter a
 * partner's own hugs inflate their own bell count.
 */
const notSelfSent = (userId: string) => ({
  NOT: { data: { path: ['senderUserId'], equals: userId } },
});

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  const { coupleId, userId } = req.user!;
  // coupleId comes from the verified JWT — no extra couple lookup needed.

  const notifications = await prisma.notification.findMany({
    where: {
      recipientId: coupleId,
      clearedAt: null,
      ...notSelfSent(userId),
    } as any,
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
      data: { ...d, isPending: false, i18nKey: 'match.connected', i18nParams: { name: profileName } },
    };
  });

  sendSuccess({ res, statusCode: 200, data: { notifications: enriched } });
};

export const markAsRead = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  // Scope the update to the caller's own notifications so one couple can never
  // mark another couple's notification as read (IDOR).
  await prisma.notification.updateMany({
    where: { id, recipientId: coupleId },
    data: { read: true }
  });
  // Bust cached unread count for this user.
  await invalidateNotifUnreadCount(coupleId);
  sendSuccess({ res, statusCode: 200, message: 'Notification marked as read' });
};

export const markAllAsRead = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  await prisma.notification.updateMany({
    where: { recipientId: coupleId, read: false },
    data: { read: true },
  });
  // Immediately bust the cached unread count so the next poll returns 0.
  await invalidateNotifUnreadCount(coupleId);
  sendSuccess({ res, statusCode: 200, message: 'All notifications marked as read' });
};

/** DELETE /notifications/:id — soft-clear one row (idempotent, IDOR-scoped). */
export const clearOne = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  const cleared = await clearNotification(coupleId, id);
  sendSuccess({ res, statusCode: 200, data: { cleared }, message: 'Notification cleared' });
};

/** DELETE /notifications — soft-clear everything visible for this couple. */
export const clearAll = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);
  const cleared = await clearAllNotifications(coupleId);
  sendSuccess({ res, statusCode: 200, data: { cleared }, message: 'Notifications cleared' });
};

export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
  const { coupleId, userId } = req.user!;
  if (!coupleId) throw new AppError('Couple ID required', 400);

  // Short-lived cache (10 s) so repeated badge-refresh calls don't hit Postgres.
  // Invalidated every time a new notification is created/marked read/cleared.
  const cached = await getCachedNotifUnreadCount(coupleId, userId);
  if (cached !== null) {
    sendSuccess({ res, statusCode: 200, data: { count: cached } });
    return;
  }

  const count = await prisma.notification.count({
    where: {
      recipientId: coupleId,
      read: false,
      clearedAt: null,
      ...notSelfSent(userId),
    } as any,
  });
  await setCachedNotifUnreadCount(coupleId, userId, count);
  sendSuccess({ res, statusCode: 200, data: { count } });
};
