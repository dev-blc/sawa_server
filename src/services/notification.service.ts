import { prisma } from '../lib/prisma';
import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { emitRealtimeNotification } from '../utils/realtime';
import { invalidateNotifUnreadCount } from '../lib/cache';
import { i18nData } from '../i18n/notif';

type NotificationData = Record<string, unknown>;

/**
 * Any client the upsert helpers can write through — the shared client by
 * default, or a `prisma.$transaction` client so a caller can commit a
 * notification atomically with the row it announces (e.g. a match accept).
 * Callers inside a transaction should pass `emitRealtime: false` and emit
 * after commit — a socket/push must never fire for a rolled-back write.
 */
type NotificationDb = PrismaClient | Prisma.TransactionClient;

const groupKeyFromData = (n: {
  type: string;
  senderId?: string | null;
  title?: string;
  data?: unknown;
}): string => {
  const d = (n.data || {}) as NotificationData;
  if (d._groupKey && typeof d._groupKey === 'string') {
    return d._groupKey;
  }

  const sender = n.senderId || (d.senderId as string) || (d.coupleId as string) || '';
  const matchId = d.matchId as string | undefined;
  const communityId = d.communityId as string | undefined;
  const title = (n.title || '').toLowerCase();

  if (n.type === 'message' && matchId) {
    return `message:match:${matchId}:${sender}`;
  }
  if (n.type === 'message' && communityId) {
    return `message:community:${communityId}:${sender}`;
  }
  if (n.type === 'match' && matchId) {
    const pending = d.isPending === true ? 'pending' : 'connected';
    return `match:${pending}:${matchId}`;
  }
  if (n.type === 'community' && communityId) {
    if (
      d.requestType === 'join' ||
      title.includes('join request') ||
      String(d.message || '').includes('want to join')
    ) {
      return `community:join:${communityId}:${sender}`;
    }
    return `community:invite:${communityId}`;
  }

  return `unique:${n.type}:${sender}:${title}:${matchId || ''}:${communityId || ''}`;
};

/** Collapse duplicate rows (same sender + same action) — keep the newest. */
export function dedupeNotificationsForList<T extends {
  id: string;
  type: string;
  senderId?: string | null;
  title?: string;
  message?: string;
  data?: unknown;
  createdAt: Date | string;
  read?: boolean;
}>(notifications: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const n of notifications) {
    const key = groupKeyFromData(n);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, n);
      continue;
    }
    const existingTime = new Date(existing.createdAt).getTime();
    const nextTime = new Date(n.createdAt).getTime();
    if (nextTime >= existingTime) {
      byKey.set(key, n);
    }
  }

  const deduped = Array.from(byKey.values());

  const connectedMatchIds = new Set<string>();
  for (const n of deduped) {
    if (n.type !== 'match') continue;
    const d = (n.data || {}) as NotificationData;
    if (d.matchId && d.isPending === false) {
      connectedMatchIds.add(String(d.matchId));
    }
  }

  const filtered = deduped.filter((n) => {
    if (n.type !== 'match') return true;
    const d = (n.data || {}) as NotificationData;
    if (d.isPending === true && d.matchId && connectedMatchIds.has(String(d.matchId))) {
      return false;
    }
    return true;
  });

  return filtered.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

async function findByGroupKey(
  recipientId: string,
  type: NotificationType,
  groupKey: string,
  db: NotificationDb = prisma,
) {
  // Was: fetch up to 80 rows + JS scan.
  // Now: single row read using PostgreSQL JSON-path filter on _groupKey.
  return db.notification.findFirst({
    where: {
      recipientId,
      type,
      data: { path: ['_groupKey'], equals: groupKey },
    } as any,
    orderBy: { createdAt: 'desc' },
  });
}

/** Replace older duplicates instead of inserting another row. */
export async function upsertGroupedNotification(params: {
  recipientId: string;
  senderId?: string;
  type: NotificationType;
  title: string;
  message: string;
  data: NotificationData;
  groupKey: string;
  emitRealtime?: boolean;
}, db: NotificationDb = prisma) {
  const data = { ...params.data, _groupKey: params.groupKey };
  const existing = await findByGroupKey(params.recipientId, params.type, params.groupKey, db);

  const notification = existing
    ? await db.notification.update({
        where: { id: existing.id },
        data: {
          senderId: params.senderId,
          title: params.title,
          message: params.message,
          data,
          read: false,
          // A re-notify must surface: the list orders by createdAt desc, so a
          // grouped row keeping its original stamp would sink under newer rows
          // exactly when it has fresh content. Un-clear it for the same reason.
          createdAt: new Date(),
          clearedAt: null,
        },
      })
    : await db.notification.create({
        data: {
          recipientId: params.recipientId,
          senderId: params.senderId,
          type: params.type,
          title: params.title,
          message: params.message,
          data,
        },
      });

  if (params.emitRealtime !== false) {
    emitRealtimeNotification(params.recipientId, {
      notificationId: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
    });
  }

  // Bust the cached unread count so the badge refreshes immediately.
  invalidateNotifUnreadCount(params.recipientId).catch(() => {});

  return notification;
}

/** Remove all notifications tied to a match (pending + connected + stray messages banner). */
export async function clearNotificationsForMatch(matchId: string, options?: {
  keepConnectedForRecipients?: string[];
}) {
  const keep = new Set(options?.keepConnectedForRecipients || []);

  // Was: fetch 500 rows across all types + JS filter on matchId.
  // Now: use Prisma JSON-path filter so the DB only returns rows for this matchId.
  const rows = await prisma.notification.findMany({
    where: {
      type: { in: ['match', 'message'] },
      data: { path: ['matchId'], equals: matchId },
    } as any,
    select: { id: true, data: true, recipientId: true, type: true },
  });

  const idsToDelete = rows
    .filter((r) => {
      const d = r.data as NotificationData;
      if (
        r.type === 'match' &&
        d?.isPending === false &&
        keep.has(r.recipientId)
      ) {
        return false;
      }
      return true;
    })
    .map((r) => r.id);

  if (idsToDelete.length > 0) {
    await prisma.notification.deleteMany({ where: { id: { in: idsToDelete } } });
    // Bust every affected couple's badge cache — these rows may be unread.
    const recipients = new Set(rows.map((r) => r.recipientId));
    recipients.forEach((rid) => invalidateNotifUnreadCount(rid).catch(() => {}));
  }
}

/**
 * Soft-clear a single notification for the caller's couple. Cleared rows leave
 * the list/unread endpoints but stay in the table (see schema note: us_mood
 * rows back mood history). Idempotent — clearing an already-cleared or unknown
 * id is a no-op, scoped by recipientId so one couple can never clear another's.
 */
export async function clearNotification(coupleId: string, notificationId: string): Promise<number> {
  const res = await prisma.notification.updateMany({
    where: { id: notificationId, recipientId: coupleId, clearedAt: null },
    data: { clearedAt: new Date(), read: true },
  });
  if (res.count > 0) {
    invalidateNotifUnreadCount(coupleId).catch(() => {});
  }
  return res.count;
}

/** Soft-clear every visible notification for the caller's couple. */
export async function clearAllNotifications(coupleId: string): Promise<number> {
  const res = await prisma.notification.updateMany({
    where: { recipientId: coupleId, clearedAt: null },
    data: { clearedAt: new Date(), read: true },
  });
  if (res.count > 0) {
    invalidateNotifUnreadCount(coupleId).catch(() => {});
  }
  return res.count;
}

/**
 * Soft-clear the couple's game-challenge notification for one gameId. Called
 * when the challenge resolves (accepted) or dies (quit) so a stale "Tap to
 * accept and play!" row can't outlive its session and dead-end the tap.
 */
export async function clearGameChallengeNotification(coupleId: string, gameId: string): Promise<void> {
  try {
    const res = await prisma.notification.updateMany({
      where: {
        recipientId: coupleId,
        type: 'system',
        clearedAt: null,
        // Two JSON-path conditions must AND explicitly — a game RESULT row
        // carries the same gameId and must survive this clear.
        AND: [
          { data: { path: ['subtype'], equals: 'us_game_challenge' } },
          { data: { path: ['gameId'], equals: gameId } },
        ],
      } as any,
      data: { clearedAt: new Date(), read: true },
    });
    if (res.count > 0) {
      invalidateNotifUnreadCount(coupleId).catch(() => {});
    }
  } catch {
    // Best-effort cleanup — never let it break the game flow.
  }
}

/**
 * Retire a planned-date REQUEST row once the plan is deleted by its creator.
 * Without this, cancelling your own date request left the partner's
 * notification (with its Accept button) live — accepting a cancelled plan
 * recreated it on both calendars.
 */
export async function clearDateRequestNotification(coupleId: string, planId: string): Promise<void> {
  try {
    const res = await prisma.notification.updateMany({
      where: {
        recipientId: coupleId,
        type: 'system',
        clearedAt: null,
        AND: [
          { data: { path: ['subtype'], equals: 'us_date_plan' } },
          { data: { path: ['id'], equals: planId } },
        ],
      } as any,
      data: { clearedAt: new Date(), read: true },
    });
    if (res.count > 0) {
      invalidateNotifUnreadCount(coupleId).catch(() => {});
    }
  } catch {
    // Best-effort cleanup — never let it break the delete flow.
  }
}

/** One pending connection request per matchId (per recipient). */
export async function upsertMatchPendingNotification(params: {
  recipientId: string;
  senderId: string;
  matchId: string;
  profileName: string;
  primaryPhoto?: string | null;
  location?: string | null;
  bio?: string | null;
  tags?: unknown;
  vibes?: unknown;
  matchCriteria?: unknown;
  emitRealtime?: boolean;
}, db: NotificationDb = prisma) {
  // Was: fetch all match notifications from sender + JS filter.
  // Now: JSON-path DB filter on matchId + isPending to retrieve only relevant rows.
  const staleRows = await db.notification.findMany({
    where: {
      recipientId: params.recipientId,
      senderId: params.senderId,
      type: 'match',
      data: { path: ['matchId'], equals: params.matchId },
    } as any,
    select: { id: true, data: true },
  });
  const staleIds = staleRows
    .filter((r) => (r.data as NotificationData)?.isPending === true)
    .map((r) => r.id);
  if (staleIds.length) {
    await db.notification.deleteMany({ where: { id: { in: staleIds } } });
  }

  return upsertGroupedNotification({
    recipientId: params.recipientId,
    senderId: params.senderId,
    type: 'match',
    title: 'New Connection Request!',
    message: `${params.profileName} wants to connect with you!`,
    emitRealtime: params.emitRealtime,
    groupKey: `match:pending:${params.matchId}`,
    data: {
      matchId: params.matchId,
      coupleId: params.senderId,
      profileName: params.profileName,
      primaryPhoto: params.primaryPhoto,
      location: params.location,
      bio: params.bio,
      tags: params.tags,
      vibes: params.vibes,
      matchCriteria: params.matchCriteria,
      isPending: true,
      ...i18nData('match.pending', { name: params.profileName }),
    },
  }, db);
}

/** One "connected" row per match per recipient. */
export async function upsertMatchConnectedNotification(params: {
  recipientId: string;
  senderId: string;
  matchId: string;
  coupleId: string;
  profileName: string;
  primaryPhoto?: string | null;
  location?: string | null;
  bio?: string | null;
  tags?: unknown;
  vibes?: unknown;
  matchCriteria?: unknown;
  emitRealtime?: boolean;
}, db: NotificationDb = prisma) {
  // Delete ALL pending match notifications from this sender to this recipient.
  // Was: fetch all + JS filter for isPending. Now: JSON-path filter on isPending.
  const pendingRows = await db.notification.findMany({
    where: {
      recipientId: params.recipientId,
      senderId: params.senderId,
      type: 'match',
      data: { path: ['isPending'], equals: true },
    } as any,
    select: { id: true },
  });
  const pendingIds = pendingRows.map((r) => r.id);
  if (pendingIds.length) {
    await db.notification.deleteMany({ where: { id: { in: pendingIds } } });
  }

  return upsertGroupedNotification({
    recipientId: params.recipientId,
    senderId: params.senderId,
    type: 'match',
    title: "You've Connected!",
    message: `You connected with ${params.profileName}!`,
    emitRealtime: params.emitRealtime,
    groupKey: `match:connected:${params.matchId}`,
    data: {
      matchId: params.matchId,
      coupleId: params.coupleId,
      profileName: params.profileName,
      primaryPhoto: params.primaryPhoto,
      location: params.location,
      bio: params.bio,
      tags: params.tags,
      vibes: params.vibes,
      matchCriteria: params.matchCriteria,
      isPending: false,
      ...i18nData('match.connected', { name: params.profileName }),
    },
  }, db);
}
