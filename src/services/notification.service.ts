import { prisma } from '../lib/prisma';
import type { NotificationType } from '@prisma/client';
import { emitRealtimeNotification } from '../utils/realtime';

type NotificationData = Record<string, unknown>;

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
      String(d.message || '').includes('wants to join')
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
) {
  const rows = await prisma.notification.findMany({
    where: { recipientId, type },
    orderBy: { createdAt: 'desc' },
    take: 80,
  });
  return rows.find((r) => (r.data as NotificationData)?._groupKey === groupKey) ?? null;
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
}) {
  const data = { ...params.data, _groupKey: params.groupKey };
  const existing = await findByGroupKey(params.recipientId, params.type, params.groupKey);

  const notification = existing
    ? await prisma.notification.update({
        where: { id: existing.id },
        data: {
          senderId: params.senderId,
          title: params.title,
          message: params.message,
          data,
          read: false,
        },
      })
    : await prisma.notification.create({
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

  return notification;
}

/** Remove all notifications tied to a match (pending + connected + stray messages banner). */
export async function clearNotificationsForMatch(matchId: string, options?: {
  keepConnectedForRecipients?: string[];
}) {
  const rows = await prisma.notification.findMany({
    where: { type: { in: ['match', 'message'] } },
    select: { id: true, data: true, recipientId: true, type: true },
    take: 500,
  });

  const keep = new Set(options?.keepConnectedForRecipients || []);
  const idsToDelete = rows
    .filter((r) => {
      const d = r.data as NotificationData;
      if (d?.matchId !== matchId) return false;
      if (
        r.type === 'match' &&
        d.isPending === false &&
        keep.has(r.recipientId)
      ) {
        return false;
      }
      return true;
    })
    .map((r) => r.id);

  if (idsToDelete.length > 0) {
    await prisma.notification.deleteMany({ where: { id: { in: idsToDelete } } });
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
}) {
  const stale = await prisma.notification.findMany({
    where: { recipientId: params.recipientId, type: 'match', senderId: params.senderId },
    select: { id: true, data: true },
  });
  const staleIds = stale
    .filter((r) => {
      const d = r.data as NotificationData;
      return d?.matchId === params.matchId && d?.isPending === true;
    })
    .map((r) => r.id);
  if (staleIds.length) {
    await prisma.notification.deleteMany({ where: { id: { in: staleIds } } });
  }

  return upsertGroupedNotification({
    recipientId: params.recipientId,
    senderId: params.senderId,
    type: 'match',
    title: 'New Connection Request!',
    message: `${params.profileName} wants to connect with you!`,
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
    },
  });
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
}) {
  // Delete ALL pending match notifications from this sender to this recipient —
  // covers stale records where a second match row exists for the same couple pair.
  const pendingRows = await prisma.notification.findMany({
    where: { recipientId: params.recipientId, senderId: params.senderId, type: 'match' },
    select: { id: true, data: true },
  });
  const pendingIds = pendingRows
    .filter((r) => {
      const d = r.data as NotificationData;
      return d?.isPending === true;
    })
    .map((r) => r.id);
  if (pendingIds.length) {
    await prisma.notification.deleteMany({ where: { id: { in: pendingIds } } });
  }

  return upsertGroupedNotification({
    recipientId: params.recipientId,
    senderId: params.senderId,
    type: 'match',
    title: "You've Connected!",
    message: `You connected with ${params.profileName}!`,
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
    },
  });
}
