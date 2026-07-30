import { prisma } from '../lib/prisma';
import { invalidateNotifUnreadCount } from '../lib/cache';
import { pushToCouple } from '../services/push.service';
import { i18nData, renderNotif } from '../i18n/notif';
import { logger } from '../utils/logger';

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

async function notifyCouple(coupleId: string, key: string): Promise<void> {
  const { title, body } = renderNotif('en', key); // English fallback; client re-localizes
  try {
    await prisma.notification.create({
      data: {
        recipientId: coupleId,
        senderId: coupleId,
        type: 'system',
        title,
        message: body,
        data: { subtype: 'subscription', navigate: 'Subscription', ...i18nData(key) },
        read: false,
      },
    });
    await invalidateNotifUnreadCount(coupleId);

    const io = (global as any).io;
    if (io) io.to(`couple:${coupleId}`).emit('notification:new', { type: 'subscription' });

    pushToCouple(coupleId, {
      title,
      body,
      data: { type: 'subscription', navigate: 'Subscription', ...i18nData(key) },
      collapseKey: 'subscription',
    }).catch(() => null);
  } catch (err: any) {
    logger.warn(`[SubNotifier] couple ${coupleId} failed: ${err.message}`);
  }
}

async function runCheck(): Promise<void> {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + DAY_MS);

    // 1) Trials ending within the next 24h — nudge once.
    const ending = await prisma.subscription.findMany({
      where: {
        status: 'TRIALING',
        trialEndsAt: { gt: now, lte: soon },
        trialEndingNotifiedAt: null,
      },
      select: { id: true, coupleId: true },
    });
    for (const s of ending) {
      await notifyCouple(s.coupleId, 'subscription.trialEnding');
      await prisma.subscription.update({
        where: { id: s.id },
        data: { trialEndingNotifiedAt: now },
      });
    }

    // 2) Trials that have ended — expire + notify.
    const trialExpired = await prisma.subscription.findMany({
      where: { status: 'TRIALING', trialEndsAt: { lte: now } },
      select: { id: true, coupleId: true },
    });
    for (const s of trialExpired) {
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
      await notifyCouple(s.coupleId, 'subscription.trialExpired');
    }

    // 3) Paid subs whose period ended and won't renew — expire + notify (safety net).
    const paidExpired = await prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'GRACE'] },
        autoRenew: false,
        currentPeriodEnd: { lte: now },
      },
      select: { id: true, coupleId: true },
    });
    for (const s of paidExpired) {
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
      await notifyCouple(s.coupleId, 'subscription.expired');
    }

    if (ending.length || trialExpired.length || paidExpired.length) {
      logger.info(
        `[SubNotifier] ending=${ending.length} trialExpired=${trialExpired.length} paidExpired=${paidExpired.length}`,
      );
    }
  } catch (err: any) {
    logger.warn(`[SubNotifier] run failed: ${err.message}`);
  }
}

/** Start the notifier — check shortly after boot, then every 6 hours. */
export const startSubscriptionNotifier = (): void => {
  setTimeout(() => runCheck().catch(() => {}), 30_000); // after sockets/db settle
  setInterval(() => runCheck().catch(() => {}), 6 * 60 * 60 * 1000);
  logger.info('💳 Subscription notifier scheduled (every 6h)');
};
