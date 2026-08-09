import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet, invalidateNotifUnreadCount } from '../lib/cache';
import { pushToCouple } from '../services/push.service';
import { i18nData, renderNotif } from '../i18n/notif';
import { logger } from '../utils/logger';

/**
 * Event Reminder Notifier Job
 * ─────────────────────────────────────────────────────────────────────────
 * The day before a confirmed couple date (a row in `planned_dates`, which only
 * exists once BOTH partners have accepted it), this job reminds the whole
 * couple:  "📅 You both have a date tomorrow — {activity}".
 *
 * Both partners get the reminder (couple-level), so `senderUserId` is set to the
 * shared `coupleId` — that way the mobile client treats it as an Us-space row and
 * shows it to both members (its self-filter only hides rows whose sender equals
 * the viewer's own user id, and a coupleId never matches a user id).
 *
 * Text is localized per recipient device by the push service and re-localized in
 * the in-app list via the attached `i18nKey` / `i18nParams`.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today + tomorrow (YYYY-MM-DD) and the current hour, all in IST. */
function istDays(): { today: string; tomorrow: string; hour: number } {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  return { today, tomorrow, hour: now.getUTCHours() };
}

export async function runCheck(): Promise<void> {
  const { today, tomorrow, hour } = istDays();
  // Quiet hours — only remind between 08:00 and 21:00 IST. Dedupe below ensures a
  // given date is announced only once regardless of how often we run.
  if (hour < 8 || hour >= 21) return;

  try {
    // A row in planned_dates is already a confirmed couple date; anything dated
    // for tomorrow needs a reminder.
    const events = await prisma.plannedDate.findMany({
      where: { rawDate: tomorrow },
      select: { id: true, coupleId: true, activity: true, dateLabel: true, rawDate: true, time: true },
    });
    if (!events.length) return;

    let sent = 0;
    for (const ev of events) {
      try {
        const coupleId = ev.coupleId;

        // Send each event's reminder at most once per day.
        const dedupeKey = `us:date_reminder:${coupleId}:${ev.id}:${today}`;
        if (await cacheGet(dedupeKey)) continue;
        await cacheSet(dedupeKey, '1', 2 * 24 * 60 * 60);

        const activity = (ev.activity || 'Your date').trim();
        const timeText = ev.time ? ` · ${ev.time}` : '';
        const params = { activity, timeText };
        const { title, body } = renderNotif('en', 'us.date.reminder', params); // client re-localizes

        await prisma.notification.create({
          data: {
            recipientId: coupleId,
            senderId: coupleId,
            type: 'system',
            title,
            message: body,
            data: {
              subtype: 'us_date_reminder',
              senderUserId: coupleId, // couple-level: both partners see it
              navigate: 'UsSpace',
              id: ev.id,
              activity,
              rawDate: ev.rawDate,
              ...(ev.time ? { time: ev.time } : {}),
              ...(ev.dateLabel ? { dateLabel: ev.dateLabel } : {}),
              ...i18nData('us.date.reminder', params),
            },
            read: false,
          },
        });
        await invalidateNotifUnreadCount(coupleId);

        const io = (global as any).io;
        if (io) io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_date_reminder' });

        pushToCouple(coupleId, {
          title,
          body,
          data: {
            type: 'us_date_reminder',
            navigate: 'UsSpace',
            activity,
            rawDate: ev.rawDate,
            ...i18nData('us.date.reminder', params),
          },
          collapseKey: `us_date_reminder:${ev.id}`,
        }).catch(() => null);

        sent += 1;
        logger.info(`[EventReminder] reminded couple ${coupleId} about "${activity}" on ${ev.rawDate}`);
      } catch (err: any) {
        logger.warn(`[EventReminder] couple ${ev.coupleId} failed: ${err.message}`);
      }
    }

    if (sent) logger.info(`[EventReminder] sent ${sent} date reminder(s) for ${tomorrow}`);
  } catch (err: any) {
    logger.warn(`[EventReminder] run failed: ${err.message}`);
  }
}

/** Start the notifier — check shortly after boot, then every 3 hours. */
export const startEventReminderNotifier = (): void => {
  setTimeout(() => runCheck().catch(() => {}), 20_000); // after sockets/db settle
  setInterval(() => runCheck().catch(() => {}), 3 * 60 * 60 * 1000);
  logger.info('📅 Event reminder notifier scheduled (every 3h, 08–21 IST)');
};
