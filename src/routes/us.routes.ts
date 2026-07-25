import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { cacheGet, cacheSet, cacheInvalidate, invalidateNotifUnreadCount } from '../lib/cache';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { pushToUser } from '../services/push.service';

const router = Router();

/** Resolve partner's userId and sender's first name for couple-internal pushes. */
async function getPartnerAndSender(
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

const FEELING_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * POST /api/v1/us/my-feeling
 *
 * Saves the authenticated user's current mood to Redis so their partner
 * can fetch it after a fresh login (even if the socket was not connected).
 */
router.post('/my-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;

  if (!coupleId || !myUserId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }

  const { feeling, note, at } = req.body as { feeling?: string; note?: string; at?: string };
  if (!feeling) {
    res.status(400).json({ success: false, error: 'feeling is required' });
    return;
  }

  try {
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

    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] my-feeling POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save feeling' });
  }
});

/**
 * GET /api/v1/us/partner-feeling
 *
 * Returns the last mood the partner shared (stored in Redis).
 * Falls back to null if nothing has been shared yet.
 */
router.get('/partner-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;

  if (!coupleId || !myUserId) {
    res.json({ success: true, data: null });
    return;
  }

  try {
    const couple = await prisma.couple.findUnique({
      where: { coupleId },
      select: { partner1Id: true, partner2Id: true },
    });

    if (!couple) {
      res.json({ success: true, data: null });
      return;
    }

    const partnerId =
      couple.partner1Id === myUserId ? couple.partner2Id : couple.partner1Id;

    if (!partnerId) {
      res.json({ success: true, data: null });
      return;
    }

    const raw = await cacheGet(`us:feeling:${coupleId}:${partnerId}`);
    if (!raw) {
      res.json({ success: true, data: null });
      return;
    }

    const feeling = JSON.parse(raw);
    res.json({ success: true, data: feeling });
  } catch (err: any) {
    logger.warn(`[UsRoutes] partner-feeling GET error: ${err.message}`);
    res.json({ success: true, data: null });
  }
});

const PLANNED_DATES_TTL = 365 * 24 * 60 * 60; // 1 year

/**
 * POST /api/v1/us/planned-dates
 * Add or update a planned date entry for the couple.
 * Body: { activity, date, rawDate, from?, time?, note? }
 */
router.post('/planned-dates', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }

  const { id, activity, date, rawDate, from, time, note } = req.body as Record<string, string>;
  if (!activity || !rawDate) { res.status(400).json({ success: false, error: 'activity and rawDate are required' }); return; }

  try {
    const key = `us:planned_dates:${coupleId}`;
    const raw = await cacheGet(key);
    const prev: any[] = raw ? JSON.parse(raw) : [];
    // Unique id lets multiple plans live on the same day; upsert by id.
    const entryId = id || `${rawDate}__${activity}__${time ?? ''}`;
    const entry = { id: entryId, activity, date: date ?? rawDate, rawDate, from: from || 'Your partner', time, note };
    const idOf = (p: any) => p.id ?? `${p.rawDate}__${p.activity}__${p.time ?? ''}`;
    const updated = [...prev.filter((p: any) => idOf(p) !== entryId), entry];
    await cacheSet(key, JSON.stringify(updated), PLANNED_DATES_TTL);
    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] planned-dates POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save planned date' });
  }
});

/**
 * GET /api/v1/us/planned-dates
 * Returns all planned dates for the couple.
 */
router.get('/planned-dates', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: [] }); return; }

  try {
    const key = `us:planned_dates:${coupleId}`;
    const raw = await cacheGet(key);
    const dates = raw ? JSON.parse(raw) : [];
    res.json({ success: true, data: dates });
  } catch (err: any) {
    logger.warn(`[UsRoutes] planned-dates GET error: ${err.message}`);
    res.json({ success: true, data: [] });
  }
});

/**
 * DELETE /api/v1/us/planned-dates/:id
 * Remove a single planned date by its unique id. Falls back to matching rawDate
 * so older clients (that delete by YYYY-MM-DD) keep working.
 */
router.delete('/planned-dates/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const { id } = req.params;
  if (!coupleId || !id) { res.status(400).json({ success: false }); return; }

  try {
    const key = `us:planned_dates:${coupleId}`;
    const raw = await cacheGet(key);
    const prev: any[] = raw ? JSON.parse(raw) : [];
    const idOf = (p: any) => p.id ?? `${p.rawDate}__${p.activity}__${p.time ?? ''}`;
    const updated = prev.filter((p: any) => idOf(p) !== id && p.rawDate !== id);
    await cacheSet(key, JSON.stringify(updated), PLANNED_DATES_TTL);
    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] planned-dates DELETE error: ${err.message}`);
    res.status(500).json({ success: false });
  }
});

/**
 * DELETE /api/v1/us/my-feeling
 * Clears the authenticated user's feeling from Redis (for testing/reset).
 */
router.delete('/my-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }
  try {
    await cacheInvalidate(`us:feeling:${coupleId}:${myUserId}`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Ask How They're Feeling ─────────────────────────────────────────────────

const ASK_FEELING_COOLDOWN = 30 * 60; // 30 min between asks (anti-spam)

/**
 * POST /api/v1/us/ask-feeling
 * Sends a gentle "how are you feeling?" nudge to the partner — push +
 * in-app notification. Throttled to once per 30 minutes per sender.
 */
router.post('/ask-feeling', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) {
    res.status(400).json({ success: false, error: 'Missing couple context' });
    return;
  }

  try {
    const throttleKey = `us:ask_feeling:${coupleId}:${myUserId}`;
    const already = await cacheGet(throttleKey);
    if (already) {
      res.status(429).json({ success: false, error: 'cooldown' });
      return;
    }

    const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);

    await cacheSet(throttleKey, '1', ASK_FEELING_COOLDOWN);

    // In-app notification for the partner's bell
    await prisma.notification.create({
      data: {
        recipientId: coupleId,
        senderId: coupleId,
        type: 'system',
        title: `${senderName} is asking how you feel`,
        message: 'Share your mood with them 💭',
        data: { subtype: 'us_ask_feeling', senderUserId: myUserId, navigate: 'UsSpace' },
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
        data: { type: 'us_ask_feeling', navigate: 'UsSpace' },
        collapseKey: 'us_ask_feeling',
      }).catch(() => null);
    }

    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] ask-feeling POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to send' });
  }
});

// ─── Fridge Notes (sticky notes between partners) ────────────────────────────

const FRIDGE_NOTES_TTL = 365 * 24 * 60 * 60; // 1 year
const fridgeKey = (coupleId: string) => `us:fridge_notes:${coupleId}`;
const MAX_FRIDGE_NOTES = 30;

type FridgeNote = {
  id: string;
  text: string;
  color: string;      // sticky note colour key chosen by author
  by: string;         // author first name
  byUserId: string;
  at: string;         // ISO created
  ackBy?: string;     // acknowledger first name
  ackAt?: string;     // ISO acknowledged
};

/**
 * GET /api/v1/us/fridge-notes
 * All sticky notes for the couple (newest first).
 */
router.get('/fridge-notes', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: [] }); return; }
  try {
    const raw = await cacheGet(fridgeKey(coupleId));
    res.json({ success: true, data: raw ? JSON.parse(raw) : [] });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes GET error: ${err.message}`);
    res.json({ success: true, data: [] });
  }
});

/**
 * POST /api/v1/us/fridge-notes
 * Create a sticky note. Body: { text, color }
 * Notifies the partner (push + in-app + socket).
 */
router.post('/fridge-notes', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  if (!coupleId || !myUserId) { res.status(400).json({ success: false, error: 'Missing couple context' }); return; }

  const { text, color } = req.body as { text?: string; color?: string };
  const trimmed = (text ?? '').trim();
  if (!trimmed) { res.status(400).json({ success: false, error: 'text is required' }); return; }
  if (trimmed.length > 200) { res.status(400).json({ success: false, error: 'Note too long (max 200 chars)' }); return; }

  try {
    const { partnerId, senderName } = await getPartnerAndSender(myUserId, coupleId);

    const note: FridgeNote = {
      id: `fn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      color: color || 'yellow',
      by: senderName,
      byUserId: myUserId,
      at: new Date().toISOString(),
    };

    const raw = await cacheGet(fridgeKey(coupleId));
    const prev: FridgeNote[] = raw ? JSON.parse(raw) : [];
    const updated = [note, ...prev].slice(0, MAX_FRIDGE_NOTES);
    await cacheSet(fridgeKey(coupleId), JSON.stringify(updated), FRIDGE_NOTES_TTL);

    // In-app notification
    await prisma.notification.create({
      data: {
        recipientId: coupleId,
        senderId: coupleId,
        type: 'system',
        title: `${senderName} left a note on the fridge`,
        message: trimmed.length > 60 ? `"${trimmed.slice(0, 57)}…"` : `"${trimmed}"`,
        data: { subtype: 'us_fridge_note', senderUserId: myUserId, navigate: 'UsSpace', noteId: note.id },
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
        body: trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed,
        data: { type: 'us_fridge_note', navigate: 'UsSpace' },
        collapseKey: 'us_fridge_note',
      }).catch(() => null);
    }

    res.json({ success: true, data: note });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes POST error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to save note' });
  }
});

/**
 * PATCH /api/v1/us/fridge-notes/:id/ack
 * Partner acknowledges a note (seen/done). Notifies the author.
 */
router.patch('/fridge-notes/:id/ack', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const myUserId = req.user?.userId;
  const { id } = req.params;
  if (!coupleId || !myUserId || !id) { res.status(400).json({ success: false }); return; }

  try {
    const raw = await cacheGet(fridgeKey(coupleId));
    const notes: FridgeNote[] = raw ? JSON.parse(raw) : [];
    const idx = notes.findIndex(n => n.id === id);
    if (idx === -1) { res.status(404).json({ success: false, error: 'Note not found' }); return; }
    if (notes[idx].byUserId === myUserId) {
      res.status(400).json({ success: false, error: 'Cannot acknowledge your own note' });
      return;
    }
    if (notes[idx].ackAt) { res.json({ success: true, data: notes[idx] }); return; }

    const { senderName } = await getPartnerAndSender(myUserId, coupleId);
    notes[idx] = { ...notes[idx], ackBy: senderName, ackAt: new Date().toISOString() };
    await cacheSet(fridgeKey(coupleId), JSON.stringify(notes), FRIDGE_NOTES_TTL);

    // Notify the note's AUTHOR that it was acknowledged
    const authorId = notes[idx].byUserId;
    await prisma.notification.create({
      data: {
        recipientId: coupleId,
        senderId: coupleId,
        type: 'system',
        title: `${senderName} acknowledged your note ✓`,
        message: notes[idx].text.length > 60 ? `"${notes[idx].text.slice(0, 57)}…"` : `"${notes[idx].text}"`,
        data: { subtype: 'us_fridge_ack', senderUserId: myUserId, navigate: 'UsSpace', noteId: id },
        read: false,
      },
    });
    await invalidateNotifUnreadCount(coupleId);

    const io = (global as any).io;
    if (io) {
      io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'acked', note: notes[idx] });
      io.to(`couple:${coupleId}`).emit('notification:new', { type: 'us_fridge_ack' });
    }

    pushToUser(authorId, {
      title: `${senderName} acknowledged your note ✓`,
      body: notes[idx].text.length > 80 ? `${notes[idx].text.slice(0, 77)}…` : notes[idx].text,
      data: { type: 'us_fridge_ack', navigate: 'UsSpace' },
      collapseKey: 'us_fridge_ack',
    }).catch(() => null);

    res.json({ success: true, data: notes[idx] });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes ACK error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Failed to acknowledge' });
  }
});

/**
 * DELETE /api/v1/us/fridge-notes/:id
 * Remove a sticky note (either partner can erase).
 */
router.delete('/fridge-notes/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  const { id } = req.params;
  if (!coupleId || !id) { res.status(400).json({ success: false }); return; }

  try {
    const raw = await cacheGet(fridgeKey(coupleId));
    const notes: FridgeNote[] = raw ? JSON.parse(raw) : [];
    const updated = notes.filter(n => n.id !== id);
    await cacheSet(fridgeKey(coupleId), JSON.stringify(updated), FRIDGE_NOTES_TTL);

    const io = (global as any).io;
    if (io) {
      io.to(`couple:${coupleId}`).emit('us:fridge-note', { action: 'deleted', noteId: id });
    }

    res.json({ success: true });
  } catch (err: any) {
    logger.warn(`[UsRoutes] fridge-notes DELETE error: ${err.message}`);
    res.status(500).json({ success: false });
  }
});

/**
 * GET /api/v1/us/game/points
 * Tic-Tac-Toe scoreboard for the couple:
 *   { points: { [userId]: wins }, streak: { userId, count } | null }
 */
router.get('/game/points', authenticate, async (req: Request, res: Response): Promise<void> => {
  const coupleId = req.user?.coupleId;
  if (!coupleId) { res.json({ success: true, data: { points: {}, streak: null } }); return; }
  try {
    const raw = await cacheGet(`us:game_points:${coupleId}`);
    const rawStreak = await cacheGet(`us:game_streak:${coupleId}`);
    res.json({
      success: true,
      data: {
        points: raw ? JSON.parse(raw) : {},
        streak: rawStreak ? JSON.parse(rawStreak) : null,
      },
    });
  } catch (err: any) {
    logger.warn(`[UsRoutes] game points GET error: ${err.message}`);
    res.json({ success: true, data: { points: {}, streak: null } });
  }
});

/**
 * POST /api/v1/us/admin-clear-feeling
 * Admin-only: clears any user's feeling by coupleId + userId.
 * Requires ?secret=SAWA_ADMIN_2026
 */
router.post('/admin-clear-feeling', async (req: Request, res: Response): Promise<void> => {
  if (req.query.secret !== 'SAWA_ADMIN_2026') { res.status(403).json({ success: false }); return; }
  const { coupleId, userId } = req.body as { coupleId?: string; userId?: string };
  if (!coupleId || !userId) { res.status(400).json({ success: false, error: 'coupleId and userId required' }); return; }
  try {
    await cacheInvalidate(`us:feeling:${coupleId}:${userId}`);
    res.json({ success: true, deleted: `us:feeling:${coupleId}:${userId}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
