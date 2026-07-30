"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dedupeNotificationsForList = dedupeNotificationsForList;
exports.upsertGroupedNotification = upsertGroupedNotification;
exports.clearNotificationsForMatch = clearNotificationsForMatch;
exports.upsertMatchPendingNotification = upsertMatchPendingNotification;
exports.upsertMatchConnectedNotification = upsertMatchConnectedNotification;
const prisma_1 = require("../lib/prisma");
const realtime_1 = require("../utils/realtime");
const cache_1 = require("../lib/cache");
const notif_1 = require("../i18n/notif");
const groupKeyFromData = (n) => {
    const d = (n.data || {});
    if (d._groupKey && typeof d._groupKey === 'string') {
        return d._groupKey;
    }
    const sender = n.senderId || d.senderId || d.coupleId || '';
    const matchId = d.matchId;
    const communityId = d.communityId;
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
        if (d.requestType === 'join' ||
            title.includes('join request') ||
            String(d.message || '').includes('want to join')) {
            return `community:join:${communityId}:${sender}`;
        }
        return `community:invite:${communityId}`;
    }
    return `unique:${n.type}:${sender}:${title}:${matchId || ''}:${communityId || ''}`;
};
/** Collapse duplicate rows (same sender + same action) — keep the newest. */
function dedupeNotificationsForList(notifications) {
    const byKey = new Map();
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
    const connectedMatchIds = new Set();
    for (const n of deduped) {
        if (n.type !== 'match')
            continue;
        const d = (n.data || {});
        if (d.matchId && d.isPending === false) {
            connectedMatchIds.add(String(d.matchId));
        }
    }
    const filtered = deduped.filter((n) => {
        if (n.type !== 'match')
            return true;
        const d = (n.data || {});
        if (d.isPending === true && d.matchId && connectedMatchIds.has(String(d.matchId))) {
            return false;
        }
        return true;
    });
    return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
async function findByGroupKey(recipientId, type, groupKey) {
    // Was: fetch up to 80 rows + JS scan.
    // Now: single row read using PostgreSQL JSON-path filter on _groupKey.
    return prisma_1.prisma.notification.findFirst({
        where: {
            recipientId,
            type,
            data: { path: ['_groupKey'], equals: groupKey },
        },
        orderBy: { createdAt: 'desc' },
    });
}
/** Replace older duplicates instead of inserting another row. */
async function upsertGroupedNotification(params) {
    const data = { ...params.data, _groupKey: params.groupKey };
    const existing = await findByGroupKey(params.recipientId, params.type, params.groupKey);
    const notification = existing
        ? await prisma_1.prisma.notification.update({
            where: { id: existing.id },
            data: {
                senderId: params.senderId,
                title: params.title,
                message: params.message,
                data,
                read: false,
            },
        })
        : await prisma_1.prisma.notification.create({
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
        (0, realtime_1.emitRealtimeNotification)(params.recipientId, {
            notificationId: notification.id,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
        });
    }
    // Bust the cached unread count so the badge refreshes immediately.
    (0, cache_1.invalidateNotifUnreadCount)(params.recipientId).catch(() => { });
    return notification;
}
/** Remove all notifications tied to a match (pending + connected + stray messages banner). */
async function clearNotificationsForMatch(matchId, options) {
    const keep = new Set(options?.keepConnectedForRecipients || []);
    // Was: fetch 500 rows across all types + JS filter on matchId.
    // Now: use Prisma JSON-path filter so the DB only returns rows for this matchId.
    const rows = await prisma_1.prisma.notification.findMany({
        where: {
            type: { in: ['match', 'message'] },
            data: { path: ['matchId'], equals: matchId },
        },
        select: { id: true, data: true, recipientId: true, type: true },
    });
    const idsToDelete = rows
        .filter((r) => {
        const d = r.data;
        if (r.type === 'match' &&
            d?.isPending === false &&
            keep.has(r.recipientId)) {
            return false;
        }
        return true;
    })
        .map((r) => r.id);
    if (idsToDelete.length > 0) {
        await prisma_1.prisma.notification.deleteMany({ where: { id: { in: idsToDelete } } });
    }
}
/** One pending connection request per matchId (per recipient). */
async function upsertMatchPendingNotification(params) {
    // Was: fetch all match notifications from sender + JS filter.
    // Now: JSON-path DB filter on matchId + isPending to retrieve only relevant rows.
    const staleRows = await prisma_1.prisma.notification.findMany({
        where: {
            recipientId: params.recipientId,
            senderId: params.senderId,
            type: 'match',
            data: { path: ['matchId'], equals: params.matchId },
        },
        select: { id: true, data: true },
    });
    const staleIds = staleRows
        .filter((r) => r.data?.isPending === true)
        .map((r) => r.id);
    if (staleIds.length) {
        await prisma_1.prisma.notification.deleteMany({ where: { id: { in: staleIds } } });
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
            ...(0, notif_1.i18nData)('match.pending', { name: params.profileName }),
        },
    });
}
/** One "connected" row per match per recipient. */
async function upsertMatchConnectedNotification(params) {
    // Delete ALL pending match notifications from this sender to this recipient.
    // Was: fetch all + JS filter for isPending. Now: JSON-path filter on isPending.
    const pendingRows = await prisma_1.prisma.notification.findMany({
        where: {
            recipientId: params.recipientId,
            senderId: params.senderId,
            type: 'match',
            data: { path: ['isPending'], equals: true },
        },
        select: { id: true },
    });
    const pendingIds = pendingRows.map((r) => r.id);
    if (pendingIds.length) {
        await prisma_1.prisma.notification.deleteMany({ where: { id: { in: pendingIds } } });
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
            ...(0, notif_1.i18nData)('match.connected', { name: params.profileName }),
        },
    });
}
//# sourceMappingURL=notification.service.js.map