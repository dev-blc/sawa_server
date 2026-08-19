import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet, invalidateNotifUnreadCount } from '../lib/cache';
import { pushToCouple, pushToUser } from '../services/push.service';
import { i18nData, renderNotif, NotifParams } from '../i18n/notif';
import { logger } from '../utils/logger';

/**
 * Celebration Notifier Job — birthdays & Sawa anniversaries
 * ─────────────────────────────────────────────────────────────────────────
 * Cloned from the shape of eventReminderNotifier.ts (setInterval, worker-0
 * gate in server.ts, 08–21 IST send window, Redis once-per-day dedupe keys).
 *
 *   • Partner's birthday TOMORROW → a quiet heads-up to the OTHER partner
 *     ("{name}'s birthday is tomorrow — plan something small and lovely").
 *   • Birthday TODAY → both partners: a warm wish to the birthday person and
 *     a gentle nudge to the partner.
 *   • Sawa anniversary (yearly, of Couple.createdAt) → both partners
 *     ("One year of your shared space").
 *
 * Per-partner targeting reuses the client's existing self-filter: a
 * Notification row is hidden from the user whose id is in `data.senderUserId`,
 * so setting it to one partner's id shows the row only to the other; setting
 * it to the coupleId (never equal to a user id) shows it to both — the exact
 * mechanism cycleNotifier and eventReminderNotifier already use.
 *
 * Text is stored in English and localized per recipient by the push service /
 * mobile client via the attached `i18nKey` / `i18nParams` (en/hi/kn/mr).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_TTL = 2 * 24 * 60 * 60; // once per day, key carries the date

/** Today + tomorrow (YYYY-MM-DD) and the current hour, all in IST. */
function istDays(): { today: string; tomorrow: string; hour: number } {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  return { today, tomorrow, hour: now.getUTCHours() };
}

/**
 * Month/day of a stored DOB, or null when unparseable. `User.dob` is a free
 * string; the app writes DD/MM/YYYY (display format) or ISO YYYY-MM-DD —
 * mirrors `ageFromDobString` in couple.controller.ts.
 */
export function dobMonthDay(dob: string | null | undefined): { m: number; d: number } | null {
  const s = String(dob ?? '').trim();
  if (!s) return null;
  let m: number;
  let d: number;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    m = +iso[2];
    d = +iso[3];
  } else {
    const parts = s.replace(/[^0-9]/g, '/').split('/').filter(Boolean);
    if (parts.length < 3) return null;
    d = +parts[0];
    m = +parts[1];
  }
  if (!m || !d || m > 12 || d > 31) return null;
  return { m, d };
}

/**
 * Does a recurring month/day land on `dateStr` (YYYY-MM-DD)?
 * Feb-29 birthdays/anniversaries celebrate on Feb 28 in non-leap years.
 */
export function matchesMonthDay(md: { m: number; d: number }, dateStr: string): boolean {
  const y = +dateStr.slice(0, 4);
  const m = +dateStr.slice(5, 7);
  const d = +dateStr.slice(8, 10);
  if (md.m === m && md.d === d) return true;
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return md.m === 2 && md.d === 29 && !isLeap && m === 2 && d === 28;
}

const firstName = (name: string | null | undefined): string =>
  (name || 'Your partner').split(/\s+/)[0];

type PartnerLite = { id: string; name: string | null; dob: string | null; role: string };

/**
 * Write one celebration Notification row + socket refresh + push.
 * `senderUserId` selects visibility (see header): a user id hides the row from
 * that user; the coupleId shows it to both partners.
 */
async function sendCelebration(opts: {
  coupleId: string;
  subtype: 'us_birthday' | 'us_anniversary';
  i18nKey: string;
  params: NotifParams;
  senderUserId: string;
  /** Push either one user's devices or the whole couple's. */
  push: { userId: string } | { couple: true };
  collapseKey: string;
  extraData?: Record<string, unknown>;
}): Promise<void> {
  const { coupleId, subtype, i18nKey, params, senderUserId, push, collapseKey, extraData } = opts;
  const { title, body } = renderNotif('en', i18nKey, params); // stored copy; client re-localizes

  await prisma.notification.create({
    data: {
      recipientId: coupleId,
      senderId: coupleId,
      type: 'system',
      title,
      message: body,
      data: {
        subtype,
        senderUserId,
        navigate: 'UsSpace',
        ...(extraData ?? {}),
        ...i18nData(i18nKey, params),
      },
      read: false,
    },
  });
  await invalidateNotifUnreadCount(coupleId);

  const io = (global as any).io;
  if (io) io.to(`couple:${coupleId}`).emit('notification:new', { type: subtype });

  const payload = {
    title,
    body,
    data: { type: subtype, navigate: 'Notifications', ...i18nData(i18nKey, params) },
    collapseKey,
  };
  if ('couple' in push) {
    pushToCouple(coupleId, payload).catch(() => null);
  } else {
    pushToUser(push.userId, payload).catch(() => null);
  }
}

/** Check one couple for a birthday (tomorrow / today) and the Sawa anniversary. */
async function checkCouple(
  c: { coupleId: string; createdAt: Date; partner1: PartnerLite | null; partner2: PartnerLite | null },
  today: string,
  tomorrow: string,
): Promise<number> {
  let sent = 0;
  const partners = [c.partner1, c.partner2].filter((p): p is PartnerLite => !!p);
  if (partners.length !== 2) return 0;

  // ── Birthdays ──────────────────────────────────────────────────────────────
  for (const person of partners) {
    const other = partners.find((p) => p.id !== person.id);
    if (!other) continue;
    const md = dobMonthDay(person.dob);
    if (!md) continue;
    // Gender token of the BIRTHDAY person (product convention: primary = m,
    // partner = f) — the en copy uses him/her.
    const g: 'm' | 'f' = person.role === 'partner' ? 'f' : 'm';
    const name = firstName(person.name);

    // Tomorrow → heads-up to the OTHER partner only.
    if (matchesMonthDay(md, tomorrow)) {
      const key = `us:celebration:bday_soon:${c.coupleId}:${person.id}:${today}`;
      if (!(await cacheGet(key))) {
        await cacheSet(key, '1', DEDUPE_TTL);
        await sendCelebration({
          coupleId: c.coupleId,
          subtype: 'us_birthday',
          i18nKey: 'us.birthday.tomorrow',
          params: { name, g },
          senderUserId: person.id, // the birthday person never sees their own heads-up
          push: { userId: other.id },
          collapseKey: 'us_birthday',
          extraData: { birthdayUserId: person.id, when: 'tomorrow' },
        });
        sent += 1;
      }
    }

    // Today → warm wish to the birthday person + gentle nudge to the partner.
    if (matchesMonthDay(md, today)) {
      const key = `us:celebration:bday:${c.coupleId}:${person.id}:${today}`;
      if (!(await cacheGet(key))) {
        await cacheSet(key, '1', DEDUPE_TTL);
        await sendCelebration({
          coupleId: c.coupleId,
          subtype: 'us_birthday',
          i18nKey: 'us.birthday.today.you',
          params: { name },
          senderUserId: other.id, // only the birthday person sees the wish
          push: { userId: person.id },
          collapseKey: 'us_birthday',
          extraData: { birthdayUserId: person.id, when: 'today' },
        });
        await sendCelebration({
          coupleId: c.coupleId,
          subtype: 'us_birthday',
          i18nKey: 'us.birthday.today.partner',
          params: { name, g },
          senderUserId: person.id, // only the partner sees the nudge
          push: { userId: other.id },
          collapseKey: 'us_birthday',
          extraData: { birthdayUserId: person.id, when: 'today' },
        });
        sent += 2;
      }
    }
  }

  // ── Sawa anniversary (yearly, of Couple.createdAt) ─────────────────────────
  const createdIST = new Date(c.createdAt.getTime() + IST_OFFSET_MS);
  const createdStr = createdIST.toISOString().slice(0, 10);
  const years = +today.slice(0, 4) - +createdStr.slice(0, 4);
  const createdMd = { m: +createdStr.slice(5, 7), d: +createdStr.slice(8, 10) };
  if (years >= 1 && matchesMonthDay(createdMd, today)) {
    const key = `us:celebration:anniv:${c.coupleId}:${today}`;
    if (!(await cacheGet(key))) {
      await cacheSet(key, '1', DEDUPE_TTL);
      const i18nKey = years === 1 ? 'us.anniversary.one' : 'us.anniversary.many';
      const params: NotifParams = years === 1 ? {} : { years: String(years) };
      await sendCelebration({
        coupleId: c.coupleId,
        subtype: 'us_anniversary',
        i18nKey,
        params,
        senderUserId: c.coupleId, // couple-level: both partners see it
        push: { couple: true },
        collapseKey: 'us_anniversary',
        extraData: { years },
      });
      sent += 1;
    }
  }

  return sent;
}

export async function runCheck(): Promise<void> {
  const { today, tomorrow, hour } = istDays();
  // Quiet hours — same send window as the sibling jobs (08:00–21:00 IST).
  // Dedupe keys above make each celebration fire once per day at most.
  if (hour < 8 || hour >= 21) return;

  try {
    // There is no indexed month/day column (dob is a free string), so this is a
    // cursor-batched scan of complete couples — the same profile cycleNotifier
    // already runs every 30 min; this job only ticks every 3h.
    const BATCH_SIZE = 500;
    let cursor: string | undefined;
    let sent = 0;
    for (;;) {
      const couples = await prisma.couple.findMany({
        where: { partner1Id: { not: null }, partner2Id: { not: null }, bannedAt: null },
        select: {
          coupleId: true,
          createdAt: true,
          partner1: { select: { id: true, name: true, dob: true, role: true } },
          partner2: { select: { id: true, name: true, dob: true, role: true } },
        },
        orderBy: { coupleId: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { coupleId: cursor }, skip: 1 } : {}),
      });
      if (!couples.length) break;

      for (const c of couples) {
        try {
          sent += await checkCouple(c, today, tomorrow);
        } catch (err: any) {
          logger.warn(`[Celebration] couple ${c.coupleId} failed: ${err.message}`);
        }
      }

      if (couples.length < BATCH_SIZE) break;
      cursor = couples[couples.length - 1].coupleId;
    }

    if (sent) logger.info(`[Celebration] sent ${sent} celebration notification(s) for ${today}`);
  } catch (err: any) {
    logger.warn(`[Celebration] run failed: ${err.message}`);
  }
}

/** Start the notifier — check shortly after boot, then every 3 hours. */
export const startCelebrationNotifier = (): void => {
  setTimeout(() => runCheck().catch(() => {}), 25_000); // after sockets/db settle
  setInterval(() => runCheck().catch(() => {}), 3 * 60 * 60 * 1000);
  logger.info('🎂 Celebration notifier scheduled (every 3h, 08–21 IST)');
};
