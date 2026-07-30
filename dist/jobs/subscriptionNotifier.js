"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSubscriptionNotifier = void 0;
const prisma_1 = require("../lib/prisma");
const cache_1 = require("../lib/cache");
const push_service_1 = require("../services/push.service");
const notif_1 = require("../i18n/notif");
const logger_1 = require("../utils/logger");
/**
 * Subscription Notifier Job
 * ─────────────────────────────────────────────────────────────────────────
 * Runs every few hours and, for each couple's subscription:
 *   • trial ending within 24h  → "your free trial ends tomorrow" (once)
 *   • trial already ended       → mark EXPIRED + "your trial has ended"
 *   • paid period ended & not renewing → mark EXPIRED + "subscription expired"
 *
 * Store lifecycle webhooks (Apple ASSN / Google RTDN) normally drive state; the
 * date-based sweeps here are a safety net for missed webhooks and for trials
 * (which have no webhook). Both partners are notified (couple-level entitlement).
 *
 * Text is localized per recipient: the push is server-rendered in each device's
 * `preferredLocale`, and the in-app row carries `i18nKey`/`i18nParams` so the app
 * re-renders it in the user's currently-selected language.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
async function notifyCouple(coupleId, key) {
    const { title, body } = (0, notif_1.renderNotif)('en', key); // English fallback; client re-localizes
    try {
        await prisma_1.prisma.notification.create({
            data: {
                recipientId: coupleId,
                senderId: coupleId,
                type: 'system',
                title,
                message: body,
                data: { subtype: 'subscription', navigate: 'Subscription', ...(0, notif_1.i18nData)(key) },
                read: false,
            },
        });
        await (0, cache_1.invalidateNotifUnreadCount)(coupleId);
        const io = global.io;
        if (io)
            io.to(`couple:${coupleId}`).emit('notification:new', { type: 'subscription' });
        (0, push_service_1.pushToCouple)(coupleId, {
            title,
            body,
            data: { type: 'subscription', navigate: 'Subscription', ...(0, notif_1.i18nData)(key) },
            collapseKey: 'subscription',
        }).catch(() => null);
    }
    catch (err) {
        logger_1.logger.warn(`[SubNotifier] couple ${coupleId} failed: ${err.message}`);
    }
}
async function runCheck() {
    try {
        const now = new Date();
        const soon = new Date(now.getTime() + DAY_MS);
        // 1) Trials ending within the next 24h — nudge once.
        const ending = await prisma_1.prisma.subscription.findMany({
            where: {
                status: 'TRIALING',
                trialEndsAt: { gt: now, lte: soon },
                trialEndingNotifiedAt: null,
            },
            select: { id: true, coupleId: true },
        });
        for (const s of ending) {
            await notifyCouple(s.coupleId, 'subscription.trialEnding');
            await prisma_1.prisma.subscription.update({
                where: { id: s.id },
                data: { trialEndingNotifiedAt: now },
            });
        }
        // 2) Trials that have ended — expire + notify.
        const trialExpired = await prisma_1.prisma.subscription.findMany({
            where: { status: 'TRIALING', trialEndsAt: { lte: now } },
            select: { id: true, coupleId: true },
        });
        for (const s of trialExpired) {
            await prisma_1.prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
            await notifyCouple(s.coupleId, 'subscription.trialExpired');
        }
        // 3) Paid subs whose period ended and won't renew — expire + notify (safety net).
        const paidExpired = await prisma_1.prisma.subscription.findMany({
            where: {
                status: { in: ['ACTIVE', 'GRACE'] },
                autoRenew: false,
                currentPeriodEnd: { lte: now },
            },
            select: { id: true, coupleId: true },
        });
        for (const s of paidExpired) {
            await prisma_1.prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
            await notifyCouple(s.coupleId, 'subscription.expired');
        }
        if (ending.length || trialExpired.length || paidExpired.length) {
            logger_1.logger.info(`[SubNotifier] ending=${ending.length} trialExpired=${trialExpired.length} paidExpired=${paidExpired.length}`);
        }
    }
    catch (err) {
        logger_1.logger.warn(`[SubNotifier] run failed: ${err.message}`);
    }
}
/** Start the notifier — check shortly after boot, then every 6 hours. */
const startSubscriptionNotifier = () => {
    setTimeout(() => runCheck().catch(() => { }), 30000); // after sockets/db settle
    setInterval(() => runCheck().catch(() => { }), 6 * 60 * 60 * 1000);
    logger_1.logger.info('💳 Subscription notifier scheduled (every 6h)');
};
exports.startSubscriptionNotifier = startSubscriptionNotifier;
//# sourceMappingURL=subscriptionNotifier.js.map