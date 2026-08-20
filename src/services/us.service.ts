/**
 * Us Space service — the couple's private shared space (moods, fridge notes,
 * planned dates, cycle calendar, mini-games). All DB/business logic for the
 * `/api/v1/us/*` routes lives here (RULES §4 honest layering); `us.routes.ts`
 * only validates request context and shapes the HTTP response. Behaviour is
 * byte-identical to the pre-extraction route handlers — this was a move, not a
 * redesign — so socket event names and payloads are unchanged.
 */
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import {
  cacheGet,
  cacheSet,
  cacheInvalidate,
  invalidateNotifUnreadCount,
} from '../lib/cache';
import { pushToUser } from './push.service';
import { clearGameChallengeNotification } from './notification.service';
import { i18nData } from '../i18n/notif';
import { type CycleSettings } from '../jobs/cycleNotifier';
import { encodeCursor, decodeCursor } from '../utils/cursor';

// ─── Shared constants ────────────────────────────────────────────────────────
export const FEELING_TTL = 7 * 24 * 60 * 60; // 7 days
const MOOD_HISTORY_DAYS = 30;
// Hard cap so the query stays bounded even for a very chatty couple
// (~2 partners × 30 days × a few moods/day sits far below this).
const MOOD_HISTORY_MAX = 200;
const ASK_FEELING_COOLDOWN = 30 * 60; // 30 min between asks (anti-spam)
export const MAX_FRIDGE_NOTES = 30;
// Default page sizes for the paginated reads (RULES §5 caps at 100).
export const PLANNED_DATES_DEFAULT_LIMIT = 100;

/** Resolve partner's userId and sender's first name for couple-internal pushes. */
export async function getPartnerAndSender(
  myUserId: string,
  coupleId: string,
): Promise<{ partnerId: string | null; senderName: string }> {
  const couple = await prisma.couple.findUnique({
    where: { coupleId },
    select: { partner1Id: true, partner2Id: true, profileName: true },
  });
  const user = await prisma.user.findUnique({
    where: { id: myUserId },
    select: { name: true, role: true },
  });
  let senderName = user?.name?.trim().split(/\s+/)[0] || '';
  if (!senderName && couple?.profileName) {
    const parts = couple.profileName.split(/\s*&\s*/);
    senderName = (user?.role === 'partner' ? parts[1] : parts[0])?.trim().split(/\s+/)[0] || '';
  }
  if (!senderName) senderName = 'Your partner';
  const partnerId = couple
    ? couple.partner1Id === myUserId ? couple.partner2Id
    : couple.partner2Id === myUserId ? couple.partner1Id
    : null
    : null;
  return { partnerId, senderName };
}

// ─── Feelings ────────────────────────────────────────────────────────────────

export async function saveMyFeeling(args: {
  coupleId: string;
  myUserId: string;
  feeling: string;
  note?: string;
  at?: string;
}): Promise<void> {
  const { coupleId, myUserId, feeling, note, at } = args;
  // Resolve sender's display name from the couple profile
  const couple = await prisma.couple.findUnique({
    where: { coupleId },
    select: { profileName: true, partner1Id: true, partner2Id: true },
  });

  const user = await prisma.user.findUnique({
    where: { id: myUserId },
    select: { name: true, role: true },
  });

  // Derive first name: prefer user.name, else first half of "Name & Partner"
  let senderName = user?.name?.trim() || '';
  if (!senderName && couple?.profileName) {
    const parts = couple.profileName.split(/\s*&\s*/);
    senderName = (user?.role === 'partner' ? parts[1] : parts[0])?.trim() || '';
  }
  if (!senderName) senderName = 'Your partner';

  const payload = {
    feeling,
    note: note ?? '',
    at: at ?? new Date().toISOString(),
    from: senderName,
  };

  await cacheSet(`us:feeling:${coupleId}:${myUserId}`, JSON.stringify(payload), FEELING_TTL);
}

export async function getPartnerFeeling(
  coupleId: string,
  myUserId: string,
): Promise<unknown | null> {
  const couple = await prisma.couple.findUnique({
    where: { coupleId },
    select: { partner1Id: true, partner2Id: true },
  });
  if (!couple) return null;

  const partnerId =
    couple.partner1Id === myUserId ? couple.partner2Id : couple.partner1Id;
  if (!partnerId) return null;

  const raw = await cacheGet(`us:feeling:${coupleId}:${partnerId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function clearMyFeeling(coupleId: string, myUserId: string): Promise<void> {
  await cacheInvalidate(`us:feeling:${coupleId}:${myUserId}`);
}

export async function adminClearFeeling(coupleId: string, userId: string): Promise<string> {
  const key = `us:feeling:${coupleId}:${userId}`;
  await cacheInvalidate(key);
  return key;
}

// ─── Mood history (read-path) ────────────────────────────────────────────────

type MoodEvent = { userId: string; mood: string; at: string };

/**
 * The couple's mood events from the last 30 days (both partners), newest first.
 * Live moods sit in Redis (7-day TTL) but every mood shared over the socket also
 * writes a Notification row (subtype 'us_mood') — those rows are the durable
 * history read here. Bounded by the 30-day window + take cap.
 */
export async function getMoodHistory(coupleId: string): Promise<MoodEvent[]> {
  const since = new Date(Date.now() - MOOD_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.notification.findMany({
    where: {
      recipientId: coupleId,
      type: 'system',
      createdAt: { gte: since },
      data: { path: ['subtype'], equals: 'us_mood' },
    },
    select: { data: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: MOOD_HISTORY_MAX,
  });

  return rows.flatMap((r) => {
    const d = r.data as { senderUserId?: unknown; feeling?: unknown } | null;
    const userId = typeof d?.senderUserId === 'string' ? d.senderUserId : null;
    const mood = typeof d?.feeling === 'string' ? d.feeling : null;
    return userId && mood ? [{ userId, mood, at: r.createdAt.toISOString() }] : [];
  });
}

// ─── Ask How They're Feeling ─────────────────────────────────────────────────

/**
 * Sends a gentle "how are you feeling?" nudge to the partner (push + in-app +
 * socket). Throttled to once per 30 minutes per sender; throws 429 'cooldown'
 * while throttled — the route maps that to the historical 429 response.
 */
export async function sendAskFeeling(args: {
  coupleId: string;
  myUserId: string;
}): Promise<void> {
  const { coupleId, myUserId } = args;
  const throttleKey = `us:ask_feeling:${coupleId}:${myUserId}`;
  const already = await cacheGet(throttleKey);
  if (already) throw new AppError('cooldown', 429);

  const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);

  await cacheSet(throttleKey, '1', ASK_FEELING_COOLDOWN);

  // In-app notification for the partner's bell
  await prisma.notification.create({
    data: {
      recipientId: coupleId,
      senderId: coupleId,
      type: 'system',
      title: `${senderName} is asking how you feel`,
      message: `Share your mood with ${senderName} 💭`,
      data: { subtype: 'us_ask_feeling', senderUserId: myUserId, navigate: 'UsSpace', ...i18nData('us.askFeeling', { name: senderName }) },
      read: false,
    },
  });
  await invalidateNotifUnreadCount(coupleId);

  // Real-time: refresh partner's notification bell + show toast if on Us page
  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_ask_feeling' });
    io.to(`couple:${coupleId}`).emit('us:ask-feeling', { from: senderName, senderUserId: myUserId });
  }

  // Push notification to partner's device
  if (partnerId) {
    pushToUser(partnerId, {
      title: `${senderName} is asking how you feel 💭`,
      body: `Let ${senderName} know how your day is going`,
      data: { type: 'us_ask_feeling', subtype: 'us_ask_feeling', navigate: 'UsSpace', ...i18nData('us.askFeeling', { name: senderName }) },
      collapseKey: 'us_ask_feeling',
    }).catch(() => null);
  }
}

// ─── Planned dates ───────────────────────────────────────────────────────────

/** Map a Postgres PlannedDate row to the client shape the app expects. */
const serializePlan = (p: {
  id: string; activity: string; dateLabel: string | null; rawDate: string;
  time: string | null; note: string | null; fromName: string | null;
}) => ({
  id: p.id,
  activity: p.activity,
  date: p.dateLabel ?? p.rawDate,
  rawDate: p.rawDate,
  from: p.fromName ?? 'Your partner',
  ...(p.time ? { time: p.time } : {}),
  ...(p.note ? { note: p.note } : {}),
});

export async function savePlannedDate(args: {
  coupleId: string;
  myUserId?: string;
  id?: string;
  activity: string;
  date?: string;
  rawDate: string;
  from?: string;
  time?: string;
  note?: string;
}): Promise<void> {
  const { coupleId, myUserId, id, activity, date, rawDate, from, time, note } = args;
  // Stable id lets multiple plans live on the same day; upsert by id.
  const entryId = id || `${rawDate}__${activity}__${time ?? ''}`;

  // Ownership guard: the client can supply `id`, and upsert's `update` branch
  // would otherwise let a caller overwrite (and reassign `coupleId` on) another
  // couple's planned date. Reject any id already owned by a different couple.
  const existing = await prisma.plannedDate.findUnique({
    where: { id: entryId },
    select: { coupleId: true },
  });
  if (existing && existing.coupleId !== coupleId) {
    throw new AppError('Not allowed', 403);
  }

  const data = {
    coupleId,
    activity,
    dateLabel: date ?? rawDate,
    rawDate,
    fromName: from || 'Your partner',
    time: time || null,
    note: note || null,
    byUserId: myUserId || null,
  };
  await prisma.plannedDate.upsert({
    where: { id: entryId },
    create: { id: entryId, ...data },
    update: data,
  });
}

/**
 * Planned dates for the couple, ordered by rawDate ascending (earliest first —
 * unchanged from the original). Now cursor-paginated + bounded (RULES §5): a
 * previously unbounded findMany. Default page 100; optional `cursor`/`limit`.
 */
export async function getPlannedDates(args: {
  coupleId: string;
  cursor?: unknown;
  limit: number;
}): Promise<{ items: ReturnType<typeof serializePlan>[]; nextCursor: string | null }> {
  const { coupleId, cursor, limit } = args;
  const decoded = decodeCursor(cursor);
  const rows = await prisma.plannedDate.findMany({
    where: {
      coupleId,
      ...(decoded
        ? {
            OR: [
              { rawDate: { gt: decoded.key } },
              { rawDate: decoded.key, id: { gt: decoded.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ rawDate: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.rawDate, last.id) : null;
  return { items: page.map(serializePlan), nextCursor };
}

/**
 * Update an existing planned date — deliberately update-only, never upsert:
 * a date REQUEST the partner has not accepted yet exists only on the
 * creator's device, and an edit must not create the server row (that would
 * sidestep acceptance). Missing row → 404, foreign row → 403.
 */
export async function updatePlannedDate(args: {
  coupleId: string;
  id: string;
  activity?: string;
  date?: string;
  rawDate?: string;
  time?: string;
  note?: string;
}): Promise<ReturnType<typeof serializePlan>> {
  const { coupleId, id, activity, date, rawDate, time, note } = args;
  const existing = await prisma.plannedDate.findUnique({
    where: { id },
    select: { coupleId: true },
  });
  if (!existing) throw new AppError('Plan not found', 404);
  if (existing.coupleId !== coupleId) throw new AppError('Not allowed', 403);

  const row = await prisma.plannedDate.update({
    where: { id },
    data: {
      ...(activity ? { activity } : {}),
      ...(rawDate ? { rawDate, dateLabel: date ?? rawDate } : {}),
      // Empty string clears; undefined leaves untouched.
      ...(time !== undefined ? { time: time || null } : {}),
      ...(note !== undefined ? { note: note || null } : {}),
    },
  });
  return serializePlan(row);
}

export async function deletePlannedDate(coupleId: string, id: string): Promise<void> {
  await prisma.plannedDate.deleteMany({
    where: { coupleId, OR: [{ id }, { rawDate: id }] },
  });
}

// ─── Fridge notes (sticky notes between partners) ────────────────────────────

// Client-facing sticky-note shape. Kept stable so the mobile app is unchanged.
export type FridgeNoteDTO = {
  id: string;
  text: string;
  color: string;
  by: string;
  byUserId: string;
  at: string;
  ackBy?: string;
  ackAt?: string;
};

/** Map a Postgres FridgeNote row to the client DTO the app already expects. */
const serializeNote = (n: {
  id: string; text: string; color: string; byName: string; byUserId: string;
  createdAt: Date; ackBy: string | null; ackAt: Date | null;
}): FridgeNoteDTO => ({
  id: n.id,
  text: n.text,
  color: n.color,
  by: n.byName,
  byUserId: n.byUserId,
  at: n.createdAt.toISOString(),
  ...(n.ackBy ? { ackBy: n.ackBy } : {}),
  ...(n.ackAt ? { ackAt: n.ackAt.toISOString() } : {}),
});

/**
 * Sticky notes for the couple, newest first. The collection is hard-capped at
 * MAX_FRIDGE_NOTES on write, so the default page returns the same set as before;
 * `cursor`/`limit` are additive for forward-compatibility (RULES §5).
 */
export async function getFridgeNotes(args: {
  coupleId: string;
  cursor?: unknown;
  limit: number;
}): Promise<{ items: FridgeNoteDTO[]; nextCursor: string | null }> {
  const { coupleId, cursor, limit } = args;
  const decoded = decodeCursor(cursor);
  const notes = await prisma.fridgeNote.findMany({
    where: {
      coupleId,
      ...(decoded
        ? {
            OR: [
              { createdAt: { lt: new Date(decoded.key) } },
              { createdAt: new Date(decoded.key), id: { lt: decoded.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = notes.length > limit;
  const page = hasMore ? notes.slice(0, limit) : notes;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null;
  return { items: page.map(serializeNote), nextCursor };
}

export async function createFridgeNote(args: {
  coupleId: string;
  myUserId: string;
  text: string; // already trimmed + length-validated by the route
  color?: string;
}): Promise<FridgeNoteDTO> {
  const { coupleId, myUserId, text, color } = args;
  const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);

  const row = await prisma.fridgeNote.create({
    data: {
      coupleId,
      text,
      color: color || 'yellow',
      byName: senderName,
      byUserId: myUserId,
    },
  });
  const note = serializeNote(row);

  // Trim to the newest MAX_FRIDGE_NOTES — delete the overflow tail.
  const overflow = await prisma.fridgeNote.findMany({
    where: { coupleId },
    orderBy: { createdAt: 'desc' },
    skip: MAX_FRIDGE_NOTES,
    select: { id: true },
  });
  if (overflow.length) {
    await prisma.fridgeNote.deleteMany({ where: { id: { in: overflow.map((o) => o.id) } } });
  }

  // In-app notification
  await prisma.notification.create({
    data: {
      recipientId: coupleId,
      senderId: coupleId,
      type: 'system',
      title: `${senderName} left a note on the fridge`,
      message: text.length > 60 ? `"${text.slice(0, 57)}…"` : `"${text}"`,
      data: { subtype: 'us_fridge_note', senderUserId: myUserId, navigate: 'UsSpace', noteId: note.id, ...i18nData('us.fridgeNote', { name: senderName, note: text.length > 80 ? `${text.slice(0, 77)}…` : text }) },
      read: false,
    },
  });
  await invalidateNotifUnreadCount(coupleId);

  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'created', note });
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_fridge_note' });
  }

  if (partnerId) {
    pushToUser(partnerId, {
      title: `${senderName} left a note on the fridge 📌`,
      body: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      data: { type: 'us_fridge_note', subtype: 'us_fridge_note', noteId: note.id, navigate: 'UsSpace', ...i18nData('us.fridgeNote', { name: senderName, note: text.length > 80 ? `${text.slice(0, 77)}…` : text }) },
      collapseKey: 'us_fridge_note',
    }).catch(() => null);
  }

  return note;
}

/**
 * Partner acknowledges a note (seen/done). Throws 404 when the note is missing
 * and 400 when acknowledging your own note; returns the note unchanged when it
 * was already acked (no re-notify) — all matching the original handler.
 */
export async function ackFridgeNote(args: {
  coupleId: string;
  myUserId: string;
  id: string;
}): Promise<FridgeNoteDTO> {
  const { coupleId, myUserId, id } = args;
  const existing = await prisma.fridgeNote.findFirst({ where: { id, coupleId } });
  if (!existing) throw new AppError('Note not found', 404);
  if (existing.byUserId === myUserId) {
    throw new AppError('Cannot acknowledge your own note', 400);
  }
  if (existing.ackAt) return serializeNote(existing);

  const { senderName } = await getPartnerAndSender(myUserId, coupleId);
  const updatedRow = await prisma.fridgeNote.update({
    where: { id },
    data: { ackBy: senderName, ackAt: new Date() },
  });
  const note = serializeNote(updatedRow);

  // Notify the note's AUTHOR that it was acknowledged
  const authorId = updatedRow.byUserId;
  await prisma.notification.create({
    data: {
      recipientId: coupleId,
      senderId: coupleId,
      type: 'system',
      title: `${senderName} acknowledged your note ✓`,
      message: note.text.length > 60 ? `"${note.text.slice(0, 57)}…"` : `"${note.text}"`,
      data: { subtype: 'us_fridge_ack', senderUserId: myUserId, navigate: 'UsSpace', noteId: id, ...i18nData('us.fridgeAck', { name: senderName, note: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text }) },
      read: false,
    },
  });
  await invalidateNotifUnreadCount(coupleId);

  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'acked', note });
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_fridge_ack' });
  }

  pushToUser(authorId, {
    title: `${senderName} acknowledged your note ✓`,
    body: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text,
    data: { type: 'us_fridge_ack', subtype: 'us_fridge_ack', noteId: id, navigate: 'UsSpace', ...i18nData('us.fridgeAck', { name: senderName, note: note.text.length > 80 ? `${note.text.slice(0, 77)}…` : note.text }) },
    collapseKey: 'us_fridge_ack',
  }).catch(() => null);

  return note;
}

export async function deleteFridgeNote(coupleId: string, id: string): Promise<void> {
  await prisma.fridgeNote.deleteMany({ where: { id, coupleId } });

  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'deleted', noteId: id });
  }
}

// ─── Menstrual cycle (Flo-style) ─────────────────────────────────────────────

export async function getCycle(coupleId: string): Promise<CycleSettings | null> {
  const state = await prisma.coupleUsState.findUnique({ where: { coupleId } });
  return state?.cycleLastPeriodStart
    ? {
        lastPeriodStart: state.cycleLastPeriodStart,
        periodLength: state.cyclePeriodLength ?? 5,
        cycleLength: state.cycleCycleLength ?? 28,
        updatedBy: state.cycleUpdatedBy ?? undefined,
        updatedByName: state.cycleUpdatedByName ?? undefined,
        updatedAt: state.cycleUpdatedAt?.toISOString(),
      }
    : null;
}

/**
 * Saves cycle settings. Only the partner-role account may set them (throws 403
 * otherwise). Clamps period/cycle length to sane ranges, notifies the primary
 * partner (neutral outbound push per DPDP), and returns the saved settings.
 */
export async function saveCycle(args: {
  coupleId: string;
  myUserId: string;
  lastPeriodStart: string;
  periodLength?: number;
  cycleLength?: number;
}): Promise<CycleSettings> {
  const { coupleId, myUserId, lastPeriodStart, periodLength, cycleLength } = args;
  const pLen = Math.min(10, Math.max(2, Number(periodLength) || 5));
  const cLen = Math.min(45, Math.max(21, Number(cycleLength) || 28));

  const me = await prisma.user.findUnique({ where: { id: myUserId }, select: { name: true, role: true } });
  if (me?.role !== 'partner') {
    throw new AppError('Only your partner can set the cycle', 403);
  }

  const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);

  const now = new Date();
  const settings: CycleSettings = {
    lastPeriodStart,
    periodLength: pLen,
    cycleLength: cLen,
    updatedBy: myUserId,
    updatedByName: senderName,
    updatedAt: now.toISOString(),
  };
  const cycleFields = {
    cycleLastPeriodStart: lastPeriodStart,
    cyclePeriodLength: pLen,
    cycleCycleLength: cLen,
    cycleUpdatedBy: myUserId,
    cycleUpdatedByName: senderName,
    cycleUpdatedAt: now,
  };
  await prisma.coupleUsState.upsert({
    where: { coupleId },
    create: { coupleId, ...cycleFields },
    update: cycleFields,
  });

  // Tell the primary partner the calendar is ready.
  await prisma.notification.create({
    data: {
      recipientId: coupleId,
      senderId: coupleId,
      type: 'system',
      title: `🌸 ${senderName} shared her cycle calendar`,
      message: 'Tap the calendar on your Us page to see it',
      data: { subtype: 'us_cycle', senderUserId: myUserId, navigate: 'UsSpace', ...i18nData('us.cycleShared', { name: senderName }) },
      read: false,
    },
  });
  await invalidateNotifUnreadCount(coupleId);

  const io = (global as any).io;
  if (io) {
    io.to(`couple:${coupleId}`).emit('us:cycle:updated', settings);
    io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_cycle' });
  }

  if (partnerId) {
    // Privacy (v3 M5 / India DPDP): a "shared her cycle calendar" line on a
    // lock screen (and across Google/Apple/Twilio) is itself a menstrual-health
    // signal. The in-app Notification row above keeps the real copy; the
    // OUTBOUND push is neutral (re-rendered per-locale from cycle.neutral).
    pushToUser(partnerId, {
      title: 'A gentle update in your space',
      body: 'Open Sawa to see it',
      // subtype lets the app's tap router open the cycle calendar directly;
      // the push COPY stays neutral (privacy, v3 M5) — only the destination
      // on the recipient's own unlocked phone is specific.
      data: { type: 'us_cycle', subtype: 'us_cycle', navigate: 'UsSpace', ...i18nData('cycle.neutral') },
      collapseKey: 'us_cycle',
    }).catch(() => null);
  }

  return settings;
}

// ─── Games (Tic-Tac-Toe / Dots & Boxes / Memory Match) ───────────────────────

type GamePoints = {
  points: Record<string, number>;
  streak: { userId: string; count: number } | null;
};

export async function getGamePoints(coupleId: string): Promise<GamePoints> {
  const [scores, state] = await Promise.all([
    prisma.usGameScore.findMany({ where: { coupleId } }),
    prisma.coupleUsState.findUnique({ where: { coupleId } }),
  ]);
  const points: Record<string, number> = {};
  for (const s of scores) points[s.userId] = s.wins;
  const streak = state?.gameStreakUserId
    ? { userId: state.gameStreakUserId, count: state.gameStreakCount }
    : null;
  return { points, streak };
}

type ActiveGame = {
  session:
    | null
    | {
        gameId: string;
        gameType: 'dab' | 'mem' | 'ttt';
        status: string;
        challengerId: string | null;
        board: (('X' | 'O' | null)[]) | null;
        state: string | null;
        turn: string;
      };
};

/**
 * The couple's current shared game session so a partner who left the screen can
 * (re)join. Auto-expires sessions idle for >24h so a forgotten challenge can
 * never block new games forever — a full day, because a paused game is now a
 * feature (us:game:leave keeps the session so both partners can quit the app
 * and pick the round back up; 3h killed a game paused over an evening).
 */
export async function getActiveGame(coupleId: string): Promise<ActiveGame> {
  const st = await prisma.coupleUsState.findUnique({ where: { coupleId } });
  if (!st?.gameSessionId || !st.gameSessionStatus) {
    return { session: null };
  }
  const ageMs = st.gameSessionAt ? Date.now() - new Date(st.gameSessionAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (ageMs > 24 * 60 * 60 * 1000) {
    await prisma.coupleUsState.update({
      where: { coupleId },
      data: {
        gameSessionId: null, gameSessionStatus: null, gameChallengerId: null,
        gameBoard: null, gameTurn: null, gameSessionAt: null,
      },
    });
    // The invite dies with the session — a "Tap to accept and play!" row for
    // an expired round would dead-end (app-side it now shows "round ended").
    await clearGameChallengeNotification(coupleId, st.gameSessionId);
    return { session: null };
  }
  // Game type is encoded in the gameId prefix. Dots & Boxes and Memory Match
  // store a serialized state string (contains '|'); Tic-Tac-Toe stores a
  // 9-char board.
  const gameType = st.gameSessionId.startsWith('dab_')
    ? 'dab'
    : st.gameSessionId.startsWith('mem_')
    ? 'mem'
    : 'ttt';
  const board =
    gameType === 'ttt'
      ? (st.gameBoard || '_________')
          .split('')
          .map((c) => (c === 'X' ? 'X' : c === 'O' ? 'O' : null))
      : null;
  return {
    session: {
      gameId: st.gameSessionId,
      gameType,
      status: st.gameSessionStatus,
      challengerId: st.gameChallengerId,
      board,
      state: gameType === 'ttt' ? null : (st.gameBoard || null),
      turn: st.gameTurn || 'X',
    },
  };
}
