import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet, invalidateNotifUnreadCount } from '../lib/cache';
import { pushToUser } from '../services/push.service';
import { i18nData } from '../i18n/notif';
import { logger } from '../utils/logger';

/**
 * Cycle Notifier Job
 * ─────────────────────────────────────────────────────────────────────────
 * Once a day (checked every 30 min, sent between 08:00–21:00 IST) this job
 * looks at every couple that has cycle data and, on milestone days, nudges
 * the PRIMARY partner (the boyfriend) with a caring heads-up:
 *   • period start      → "be extra gentle and caring"
 *   • fertile window    → "a little extra love goes a long way"
 *   • ovulation day     → "treat her with chocolates, make her feel special"
 *   • PMS days          → "extra patience and warm hugs"
 *
 * The girl (partner role) sets the data; she never receives these nudges —
 * `senderUserId` is set to her id so the client filters them out for her.
 */

export type CycleSettings = {
  lastPeriodStart: string; // YYYY-MM-DD
  periodLength: number;
  cycleLength: number;
  updatedBy?: string;
  updatedByName?: string;
  updatedAt?: string;
};

export const cycleKey = (coupleId: string) => `us:cycle:${coupleId}`;
export const CYCLE_INDEX_KEY = 'us:cycle_index';
export const CYCLE_TTL = 365 * 24 * 60 * 60;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today's date + hour in IST (couples are India-based). */
function istNow(): { dateStr: string; hour: number } {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  const dateStr = d.toISOString().slice(0, 10);
  return { dateStr, hour: d.getUTCHours() };
}

/** 1-based day within the (predicted) cycle for a YYYY-MM-DD date. */
export function cycleDayFor(dateStr: string, s: CycleSettings): number {
  const start = Date.UTC(
    Number(s.lastPeriodStart.slice(0, 4)),
    Number(s.lastPeriodStart.slice(5, 7)) - 1,
    Number(s.lastPeriodStart.slice(8, 10)),
  );
  const day = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
  );
  const diff = Math.round((day - start) / 86400000);
  const len = Math.max(21, s.cycleLength || 28);
  return ((diff % len) + len) % len + 1;
}

type Milestone = 'pre_period' | 'period' | 'fertile' | 'ovulation' | 'pms';

/** Milestone that starts on this cycle day, if any. */
function milestoneFor(day: number, s: CycleSettings): Milestone | null {
  const len = Math.max(21, s.cycleLength || 28);
  const ovulation = len - 14;
  if (day === 1) return 'period';
  if (day === ovulation - 5) return 'fertile';
  if (day === ovulation) return 'ovulation';
  // Advance heads-up: ~2 days before the next period (day len-1 → period on day 1).
  if (day === len - 1) return 'pre_period';
  if (day === len - 2) return 'pms';
  return null;
}

function messagesFor(milestone: Milestone, girl: string, boy: string): { title: string; body: string } {
  switch (milestone) {
    case 'pre_period':
      return {
        title: `🌸 ${girl}'s period is coming soon`,
        body: `Hey ${boy}, ${girl} may get her period in a day or two — be extra gentle and stock up on her favourites 💗`,
      };
    case 'period':
      return {
        title: `🌸 ${girl}'s period may start today`,
        body: `Hey ${boy}, be extra gentle and caring with her today 💗`,
      };
    case 'fertile':
      return {
        title: `💞 ${girl}'s fertile window starts today`,
        body: `Hey ${boy}, a little extra love goes a long way this week`,
      };
    case 'ovulation':
      return {
        title: `💝 ${girl} is in her ovulation period`,
        body: `Hey ${boy}, give her some treats and chocolates to make her feel special!`,
      };
    case 'pms':
      return {
        title: `🫂 ${girl} may have mood swings now`,
        body: `Hey ${boy}, ${girl} is in her PMS phase just before her period — she might feel moody or extra sensitive. Be patient, compliment her, and surprise her with something she loves 💗`,
      };
  }
}

export async function runCheck(): Promise<void> {
  const { dateStr, hour } = istNow();
  // Quiet hours — only nudge between 08:00 and 21:00 IST.
  if (hour < 8 || hour >= 21) return;

  try {
    // Source of truth is Postgres: every couple that has set a cycle.
    // Cursor-batched so a large table streams through in fixed-size pages
    // instead of materializing every row in memory at once.
    const BATCH_SIZE = 500;
    let cursor: string | undefined;
    for (;;) {
    const states: Array<{
      coupleId: string;
      cycleLastPeriodStart: unknown;
      cyclePeriodLength: number | null;
      cycleCycleLength: number | null;
      cycleUpdatedBy: string | null;
      cycleUpdatedByName: string | null;
      cycleUpdatedAt: Date | null;
    }> = await prisma.coupleUsState.findMany({
      where: { cycleLastPeriodStart: { not: null } },
      select: {
        coupleId: true,
        cycleLastPeriodStart: true,
        cyclePeriodLength: true,
        cycleCycleLength: true,
        cycleUpdatedBy: true,
        cycleUpdatedByName: true,
        cycleUpdatedAt: true,
      },
      orderBy: { coupleId: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { coupleId: cursor }, skip: 1 } : {}),
    });
    if (!states.length) break;

    for (const st of states) {
      try {
        const coupleId = st.coupleId;
        const settings: CycleSettings = {
          lastPeriodStart: st.cycleLastPeriodStart as string,
          periodLength: st.cyclePeriodLength ?? 5,
          cycleLength: st.cycleCycleLength ?? 28,
          updatedBy: st.cycleUpdatedBy ?? '',
          updatedByName: st.cycleUpdatedByName ?? '',
          updatedAt: st.cycleUpdatedAt?.toISOString() ?? '',
        };

        const day = cycleDayFor(dateStr, settings);
        const milestone = milestoneFor(day, settings);
        if (!milestone) continue;

        // Send each milestone at most once per day per couple.
        const dedupeKey = `us:cycle_notif:${coupleId}:${dateStr}:${milestone}`;
        if (await cacheGet(dedupeKey)) continue;
        await cacheSet(dedupeKey, '1', 2 * 24 * 60 * 60);

        // Resolve the two partners — nudges go to the PRIMARY (boy) only.
        const users = await prisma.user.findMany({
          where: { coupleId },
          select: { id: true, name: true, role: true },
        });
        const primary = users.find(u => u.role === 'primary');
        const partner = users.find(u => u.role === 'partner');
        if (!primary || !partner) continue;

        const girl = (partner.name || 'Your partner').split(/\s+/)[0];
        const boy = (primary.name || 'there').split(/\s+/)[0];
        const { title, body } = messagesFor(milestone, girl, boy);

        await prisma.notification.create({
          data: {
            recipientId: coupleId,
            senderId: coupleId,
            type: 'system',
            title,
            message: body,
            data: {
              subtype: 'us_cycle',
              senderUserId: partner.id, // she never sees her own cycle nudges
              navigate: 'UsSpace',
              milestone,
              ...i18nData(`cycle.${milestone}`, { girl, boy }),
            },
            read: false,
          },
        });
        await invalidateNotifUnreadCount(coupleId);

        const io = (global as any).io;
        if (io) io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_cycle' });

        // Privacy (v3 M5 / India DPDP): the OUTBOUND push transits Google/Apple/
        // Twilio and shows on a lock screen, so it must not name the cycle phase
        // or prediction. Send a neutral line and drop `milestone` + the
        // `cycle.<phase>` i18n key from the push payload (either would re-render
        // / expose the phase client-side). The specific phase content lives only
        // in the in-app Notification row (created above) and the socket emit,
        // both behind auth. `localizeFor` re-renders `cycle.neutral` in each
        // recipient's locale (and the WhatsApp mirror does the same).
        pushToUser(primary.id, {
          title: 'A gentle update in your space',
          body: 'Open Sawa to see it',
          data: { type: 'us_cycle', subtype: 'us_cycle', navigate: 'UsSpace', ...i18nData('cycle.neutral') },
          collapseKey: 'us_cycle',
        }).catch(() => null);

        // Privacy: do not log the cycle phase/day against a coupleId — that is
        // menstrual-health data landing in Winston (and any log aggregator).
        logger.info(`[CycleNotifier] sent nudge for couple ${coupleId}`);
      } catch (err: any) {
        logger.warn(`[CycleNotifier] couple ${st.coupleId} failed: ${err.message}`);
      }
    }

    if (states.length < BATCH_SIZE) break;
    cursor = states[states.length - 1].coupleId;
    }
  } catch (err: any) {
    logger.warn(`[CycleNotifier] run failed: ${err.message}`);
  }
}

// Overlap guard: if a run is slow (large scan / DB latency) the next 30-min tick
// must not start a second concurrent pass (which would double-scan and risk
// duplicate pushes). Ticks that arrive while a run is in flight are skipped.
let _cycleRunning = false;
const guardedRun = async (): Promise<void> => {
  if (_cycleRunning) {
    logger.warn('[CycleNotifier] previous run still in progress — skipping this tick');
    return;
  }
  _cycleRunning = true;
  try {
    await runCheck();
  } finally {
    _cycleRunning = false;
  }
};

/** Start the notifier — immediate check on boot, then every 30 minutes. */
export const startCycleNotifier = (): void => {
  setTimeout(() => guardedRun().catch(() => {}), 15_000); // after sockets/db settle
  setInterval(() => guardedRun().catch(() => {}), 30 * 60 * 1000);
  logger.info('🌸 Cycle notifier scheduled (every 30 min, 08–21 IST)');
};
