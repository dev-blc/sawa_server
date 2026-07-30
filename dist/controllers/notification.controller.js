"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUnreadCount = exports.markAllAsRead = exports.markAsRead = exports.getNotifications = void 0;
const prisma_1 = require("../lib/prisma");
const response_1 = require("../utils/response");
const AppError_1 = require("../utils/AppError");
const notification_service_1 = require("../services/notification.service");
const cache_1 = require("../lib/cache");
const getNotifications = async (req, res) => {
    const { coupleId } = req.user;
    // coupleId comes from the verified JWT — no extra couple lookup needed.
    const notifications = await prisma_1.prisma.notification.findMany({
        where: { recipientId: coupleId },
        include: {
            sender: { select: { id: true, profileName: true, primaryPhoto: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 200 // show up to 200 most-recent rows (server dedup collapses duplicates further)
    });
    const formatted = (0, notification_service_1.dedupeNotificationsForList)(notifications.map((n) => ({
        ...n,
        _id: n.id,
        sender: n.sender ? { ...n.sender, _id: n.sender.id } : null,
    })));
    const matchIds = formatted
        .filter((n) => n.type === 'match')
        .map((n) => n.data?.matchId)
        .filter((id) => typeof id === 'string' && id.length > 0);
    const acceptedMatchIds = new Set();
    if (matchIds.length > 0) {
        const accepted = await prisma_1.prisma.match.findMany({
            where: { id: { in: matchIds }, status: 'accepted' },
            select: { id: true },
        });
        accepted.forEach((m) => acceptedMatchIds.add(m.id));
    }
    const enriched = formatted.map((n) => {
        if (n.type !== 'match')
            return n;
        const d = (n.data || {});
        const matchId = d.matchId;
        if (!matchId || !acceptedMatchIds.has(matchId) || d.isPending === false) {
            return n;
        }
        const profileName = d.profileName ||
            n.sender?.profileName ||
            'a couple';
        return {
            ...n,
            title: "You've Connected!",
            message: `You connected with ${profileName}!`,
            data: { ...d, isPending: false, i18nKey: 'match.connected', i18nParams: { name: profileName } },
        };
    });
    (0, response_1.sendSuccess)({ res, statusCode: 200, data: { notifications: enriched } });
};
exports.getNotifications = getNotifications;
const markAsRead = async (req, res) => {
    const { coupleId } = req.user;
    const { id } = req.params;
    await prisma_1.prisma.notification.update({
        where: { id },
        data: { read: true }
    });
    // Bust cached unread count for this user.
    if (coupleId)
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Notification marked as read' });
};
exports.markAsRead = markAsRead;
const markAllAsRead = async (req, res) => {
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    await prisma_1.prisma.notification.updateMany({
        where: { recipientId: coupleId, read: false },
        data: { read: true },
    });
    // Immediately bust the cached unread count so the next poll returns 0.
    await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'All notifications marked as read' });
};
exports.markAllAsRead = markAllAsRead;
const getUnreadCount = async (req, res) => {
    const { coupleId } = req.user;
    if (!coupleId)
        throw new AppError_1.AppError('Couple ID required', 400);
    // Short-lived cache (10 s) so repeated badge-refresh calls don't hit Postgres.
    // Invalidated every time a new notification is created/marked read.
    const cached = await (0, cache_1.getCachedNotifUnreadCount)(coupleId);
    if (cached !== null) {
        (0, response_1.sendSuccess)({ res, statusCode: 200, data: { count: cached } });
        return;
    }
    const count = await prisma_1.prisma.notification.count({
        where: { recipientId: coupleId, read: false }
    });
    await (0, cache_1.setCachedNotifUnreadCount)(coupleId, count);
    (0, response_1.sendSuccess)({ res, statusCode: 200, data: { count } });
};
exports.getUnreadCount = getUnreadCount;
//# sourceMappingURL=notification.controller.js.map